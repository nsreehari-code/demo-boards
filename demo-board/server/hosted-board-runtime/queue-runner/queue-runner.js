#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostedBoardQueueLaneRegistry, createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport, startQueueLaneRunners } from 'yaml-flow/board-live-cards-node';
import { buildBoardBundle as buildFirebaseBoardBundle } from '../firebase-adapter/build-board-bundle.js';
import { initializeFirebaseServices } from '../firebase-adapter/firebase-init.js';
import { loadFirebaseHostConfig, resolveConfigRelativePath } from '../firebase-adapter/load-config.js';
import { createDynamicBoards } from '../boards-index/dynamic-boards.js';
import { buildBoardBundle as buildLocalFsBoardBundle } from '../localfs-adapter/build-board-bundle.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import { buildHostedBoardRuntimeNeeds, executeChatAgentRequest } from '../host-shared/chat-agent-handler/execute-chat-agent-request.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../host-shared/logging.js';
import {
  createHostedImmediateTaskExecutorRef,
  loadTaskExecutorModule,
} from '../host-shared/worker-modules/task-executor-module.js';
import { createWakeTrigger, queueCollectionPath } from '../host-shared/lanes/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'hosted-board-runtime.config.json');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readCardId(request) {
  return normalizeText(request?.args?.cardId)
    || normalizeText(request?.args?.card_id)
    || normalizeText(request?.output?.cardId)
    || normalizeText(request?.output?.card_id);
}

function joinParts(parts) {
  return parts.filter((part) => typeof part === 'string' && part.trim()).join(' ');
}

function summarizeTaskExecutorRequest(request, lease) {
  const sourceDef = request?.source_def && typeof request.source_def === 'object' && !Array.isArray(request.source_def)
    ? request.source_def
    : request?.args?.source_def && typeof request.args.source_def === 'object' && !Array.isArray(request.args.source_def)
      ? request.args.source_def
      : {};
  return joinParts([
    readCardId(request),
    normalizeText(sourceDef?.kind),
    normalizeText(sourceDef?.bindTo),
    normalizeText(sourceDef?.outputFile),
  ]);
}

function summarizeChatAgentRequest(request, lease) {
  const queueProbe = normalizeText(request?.args?.probe)
    || normalizeText(request?.probe);
  const queueIsProbe = normalizeText(request?.args?.isProbe)
    || normalizeText(request?.isProbe);
  return joinParts([
    readCardId(request),
    normalizeText(request?.args?.turnId) || normalizeText(request?.args?.turn_id) || normalizeText(request?.args?.turn),
    queueIsProbe ? `isProbe ${queueIsProbe}` : '',
    queueProbe ? `probe ${queueProbe}` : '',
    'chat-handler',
  ]);
}

function summarizeProcessAccumulatedRequest(message, lease) {
  return '';
}

function summarizeLaneRequest(laneId, message, lease) {
  if (laneId === 'task-executor') {
    return summarizeTaskExecutorRequest(message, lease);
  }
  if (laneId === 'chat-agent') {
    return summarizeChatAgentRequest(message, lease);
  }
  return summarizeProcessAccumulatedRequest(message, lease);
}

function instrumentLaneRegistry(registry, boardId, processLogger) {
  return {
    ...registry,
    lanes: Array.isArray(registry?.lanes)
      ? registry.lanes.map((lane) => {
          const laneLogger = processLogger.child(`${boardId}:${lane.id}`);
          const originalHandle = lane.handle?.bind(lane);
          if (typeof originalHandle !== 'function') {
            return lane;
          }
          return {
            ...lane,
            async handle(message, lease) {
              const details = summarizeLaneRequest(lane.id, message, lease);
              laneLogger.info(joinParts(['picked-up', details]));
              try {
                const result = await originalHandle(message, lease);
                laneLogger.info(joinParts(['success', details]));
                return result;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                laneLogger.error(joinParts(['failed', details, errorMessage]));
                throw error;
              }
            },
          };
        })
      : [],
  };
}

function traceEnabled() {
  return String(process.env.DEBUG_QUEUE_RUNNER_TRACE || '').trim() === '1';
}

function trace(message) {
  if (!traceEnabled()) return;
  console.log(`[queue-runner-trace] ${message}`);
}

function isDummyTaskExecutorRequest(args) {
  return args
    && typeof args === 'object'
    && !Array.isArray(args)
    && args.subcommand === 'tt-dummy';
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

function createExplicitQueueLanes({ boardId, boardConfig, bundle, runtime, logger, taskExecutor, controlplaneUrl, serverUrl, mcpServerUrl, apiBasePrefix }) {
  const boardRuntimeNeeds = buildHostedBoardRuntimeNeeds(boardId, boardConfig, {
    serverUrl,
    mcpServerUrl,
    apiBasePrefix,
    configDir: runtime.configDir,
    foundryAgents: runtime.foundryAgents,
    chatFlowTimeoutMs: runtime.chatFlowTimeoutMs,
    chatInvokeRefTimeoutMs: runtime.chatInvokeRefTimeoutMs,
    chatCopilotTimeoutMs: runtime.chatCopilotTimeoutMs,
  });
  const queueStoreRef = bundle.boardContextConfig.queueStoreRef;
  if (!queueStoreRef) {
    throw new Error(`Hosted queue-runner requires queueStoreRef for board ${boardId}`);
  }

  const laneRuntime = {
    __drainProcessAccumulatedLane: runtime.__drainProcessAccumulatedLane,
    queueLaneTuning: runtime.queueLaneTuning,
    async handleChatAgentRequest(request) {
      await executeChatAgentRequest(request, boardId, boardRuntimeNeeds);
    },
  };

  return createHostedBoardQueueLaneRegistry({
    boardId,
    queueStoreRef,
    runtime: laneRuntime,
    boardAdapter: bundle.boardAdapter,
    logger,
    executeTaskExecutorRequest: taskExecutor
      ? async (args, request) => {
          if (isDummyTaskExecutorRequest(args)) {
            const marker = typeof args.marker === 'string' ? args.marker : '';
            console.log(`[queue-runner] tt-dummy-picked-up board=${boardId}${marker ? ` marker=${marker}` : ''}`);
            return;
          }
          const executorRequest = args && typeof args === 'object' && !Array.isArray(args)
            ? {
                ...args,
                ...(request.output ? { output: request.output } : {}),
                ...(request.diagnostics ? { diagnostics: request.diagnostics } : {}),
                ...(request.callback ? { callback: request.callback } : {}),
                ...(request.extra ? { extra: request.extra } : {}),
              }
            : request;
          trace(`task-executor-handle-start board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)} callback=${Boolean(executorRequest?.callback)} output=${Boolean(executorRequest?.output)}`);
          await taskExecutor(executorRequest);
          trace(`task-executor-handle-complete board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)}`);
        }
      : undefined,
  });
}

async function main() {
  const processLogger = createLogger('queue-runner', { filePath: HOSTED_SERVER_LOG_PATH });
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH, process.argv.slice(2), 'queueRunner');
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  await dynamicBoards.ensureSeeded();
  const stopSubscriptions = [];
  let keepAliveTimer = null;
  const buildBoardBundle = hostConfig.storageAdapter === 'localfs'
    ? buildLocalFsBoardBundle
    : buildFirebaseBoardBundle;

  const boardConfigs = await dynamicBoards.list();
  for (const boardConfig of boardConfigs) {
    const boardId = boardConfig.id;
    const logger = processLogger.child(`${boardId}:queue`);
    const callbackServerOrigin = hostConfig.serverOrigin || 'http://127.0.0.1:7799';
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
        taskExecutorRef: createHostedImmediateTaskExecutorRef(boardId),
        resolveConfigRelativePath,
      },
    );
    const taskExecutor = loadTaskExecutorModule();
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

    const laneRegistry = instrumentLaneRegistry(createExplicitQueueLanes({
      boardId,
      boardConfig,
      bundle,
      runtime: {
        ...runtime,
        configDir: hostConfig.configDir,
        foundryAgents: hostConfig.foundryAgents,
        chatFlowTimeoutMs: hostConfig.chatFlowTimeoutMs,
        chatInvokeRefTimeoutMs: hostConfig.chatInvokeRefTimeoutMs,
        chatCopilotTimeoutMs: hostConfig.chatCopilotTimeoutMs,
      },
      logger,
      taskExecutor,
      controlplaneUrl,
      serverUrl: callbackServerOrigin,
      mcpServerUrl: hostConfig.mcpServerUrl,
      apiBasePrefix: hostConfig.apiBasePrefix,
    }), boardId, processLogger);

    const stopRunner = startQueueLaneRunners(laneRegistry);
    stopSubscriptions.push(stopRunner);
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {}, 1 << 30);
    }
  }

  processLogger.info(`Watching ${boardConfigs.length} board(s)`);

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
  const processLogger = createLogger('queue-runner', { filePath: HOSTED_SERVER_LOG_PATH });
  processLogger.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
