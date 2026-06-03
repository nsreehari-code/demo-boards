#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport, startQueueLaneRunners } from 'yaml-flow/board-live-cards-node';
import { buildBoardBundle as buildFirebaseBoardBundle } from '../firebase-adapter/build-board-bundle.js';
import { initializeFirebaseServices } from '../firebase-adapter/firebase-init.js';
import { loadFirebaseHostConfig, resolveConfigRelativePath } from '../firebase-adapter/load-config.js';
import { buildBoardBundle as buildLocalFsBoardBundle } from '../localfs-adapter/build-board-bundle.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import { loadLegacyBoardChatRuntime } from '../host-shared/chat-agent-handler/legacy-chat-runtime.js';
import { executeChatAgentRequest } from '../host-shared/chat-agent-handler/execute-chat-agent-request.js';
import { createLogger } from '../host-shared/logging.js';
import { loadTaskExecutorModule } from '../host-shared/worker-modules/task-executor-module.js';
import {
  applyLaneTuning,
  createBoardWorkerLane,
  createQueueStorageLane,
  createWakeTrigger,
  queueCollectionPath,
} from '../host-shared/lanes/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, 'queue-runner.config.json');

function traceEnabled() {
  return String(process.env.DEBUG_QUEUE_RUNNER_TRACE || '').trim() === '1';
}

function trace(message) {
  if (!traceEnabled()) return;
  console.log(`[queue-runner-trace] ${message}`);
}

async function postMcp(url, tool, args = {}) {
  const targetUrl = new URL(url);
  const requestBody = JSON.stringify({ tool, args });
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const { status, raw } = await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode || 0, raw: responseBody });
        });
      },
    );
    request.setTimeout(15000, () => {
      request.destroy(new Error('The operation was aborted due to timeout'));
    });
    request.on('error', reject);
    request.write(requestBody);
    request.end();
  });
  const payload = raw ? JSON.parse(raw) : {};

  if (status < 200 || status >= 300) {
    const message = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string'
      ? payload.error
      : raw || `HTTP ${status}`;
    throw new Error(`${tool} failed: ${message}`);
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.status === 'fail' || payload.status === 'error') {
      throw new Error(payload.error || `${tool} returned ${payload.status}`);
    }
  }

  return payload;
}

function createExplicitQueueLanes({ boardId, boardConfig, bundle, runtime, logger, taskExecutor, webhooksUrl, controlplaneUrl, serverUrl, apiBasePrefix }) {
  const tuning = runtime.queueLaneTuning ?? {};
  const lanes = [];
  const chatRuntime = loadLegacyBoardChatRuntime(boardId, boardConfig, { serverUrl, apiBasePrefix });

  lanes.push(applyLaneTuning(createQueueStorageLane(
    'process-accumulated',
    bundle.boardAdapter.processAccumulatedStore(),
    async () => {
      await postMcp(webhooksUrl, 'webhook.process-accumulated');
    },
    (error, lease) => {
      logger.error(
        `[queue-runner] process-accumulated failed for ${boardId} (attempt ${lease.attempt}): ${String(error && error.message || error)}`,
      );
    },
  ), tuning.processAccumulated));

  lanes.push(applyLaneTuning(createBoardWorkerLane(
    'chat-agent',
    bundle.boardAdapter.chatAgentStore(),
    async (request) => {
      const cardId = typeof request?.args?.cardId === 'string' ? request.args.cardId : '';
      try {
        await executeChatAgentRequest(request, boardId, chatRuntime);
      } finally {
        if (cardId) {
          await postMcp(controlplaneUrl, 'setstate.chat-processing-done', { board_id: boardId, card_id: cardId }).catch(() => {});
        }
      }
    },
    (error, lease) => {
      const cardId = typeof lease.message?.args?.cardId === 'string' ? lease.message.args.cardId : '';
      logger.error(
        `[queue-runner] chat-agent failed for ${boardId}${cardId ? `/${cardId}` : ''} (attempt ${lease.attempt}): ${String(error && error.message || error)}`,
      );
    },
  ), tuning.chatAgent));

  if (taskExecutor) {
    lanes.push(applyLaneTuning(createBoardWorkerLane(
      'task-executor',
      bundle.boardAdapter.boardWorkerStore(),
      async (request) => {
        const executorRequest = request?.args && typeof request.args === 'object' && !Array.isArray(request.args)
          ? {
              ...request.args,
              ...(request.output ? { output: request.output } : {}),
              ...(request.diagnostics ? { diagnostics: request.diagnostics } : {}),
              ...(request.callback ? { callback: request.callback } : {}),
              ...(request.extra ? { extra: request.extra } : {}),
            }
          : request;
        trace(`task-executor-handle-start board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)} callback=${Boolean(executorRequest?.callback)} output=${Boolean(executorRequest?.output)}`);
        await taskExecutor(executorRequest);
        trace(`task-executor-handle-complete board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)}`);
      },
      (error, lease) => {
        logger.error(
          `[queue-runner] task-executor failed for ${boardId} (attempt ${lease.attempt}): ${String(error && error.message || error)}`,
        );
      },
    ), tuning.taskExecutor));
  }

  return lanes;
}

async function main() {
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH);
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const stopSubscriptions = [];
  let keepAliveTimer = null;
  const buildBoardBundle = hostConfig.storageAdapter === 'localfs'
    ? buildLocalFsBoardBundle
    : buildFirebaseBoardBundle;

  for (const [boardId, boardConfig] of Object.entries(hostConfig.boards)) {
    const logger = createLogger(`queue:${boardId}`);
    const callbackServerOrigin = hostConfig.serverOrigin || 'http://127.0.0.1:7810';
    const apiBaseUrl = `${callbackServerOrigin}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`;
    const webhooksUrl = `${apiBaseUrl}/mcp-webhooks`;
    const controlplaneUrl = `${apiBaseUrl}/mcp-controlplane`;
    const bundle = buildBoardBundle(
      boardId,
      boardConfig,
      adapterServices,
      {},
      {
        callbackTransport: createHttpBoardCallbackTransport(webhooksUrl),
        configDir: hostConfig.configDir,
        resolveConfigRelativePath,
      },
    );
    const taskExecutor = await loadTaskExecutorModule(boardId, boardConfig, resolveConfigRelativePath, hostConfig.configDir);
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`,
      boardId,
      boards: [bundle.boardContextConfig],
      invocationAdapter: {
        async invoke(ref) {
          return {
            dispatched: false,
            error: `No invocation adapter configured for ${ref?.howToRun || 'unknown'}`,
          };
        },
      },
      logger,
    });

    const lanes = createExplicitQueueLanes({
      boardId,
      boardConfig,
      bundle,
      runtime,
      logger,
      taskExecutor,
      webhooksUrl,
      controlplaneUrl,
      serverUrl: callbackServerOrigin,
      apiBasePrefix: hostConfig.apiBasePrefix,
    });

    const stopRunner = startQueueLaneRunners(lanes);
    stopSubscriptions.push(stopRunner);
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {}, 1 << 30);
    }
  }

  console.log(`[queue-runner] Watching ${Object.keys(hostConfig.boards).length} board(s)`);

  function shutdown() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    for (const stop of stopSubscriptions.splice(0)) {
      try {
        stop();
      } catch {
      }
    }
    setTimeout(() => process.exit(0), 0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[queue-runner] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
