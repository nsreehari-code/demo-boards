#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport, invokeExecutionRef } from 'yaml-flow/board-live-cards-node';
import { MemoryStore, buildStepHandlersForFlow, createStepMachine, loadStepFlow } from 'yaml-flow/step-machine-public';
import { buildBoardBundle } from '../server-firebase-shared/build-board-bundle.js';
import { initializeFirebaseServices } from '../server-firebase-shared/firebase-init.js';
import { loadLegacyBoardChatRuntime } from '../server-firebase-shared/legacy-chat-runtime.js';
import { loadFirebaseHostConfig, resolveConfigRelativePath } from '../server-firebase-shared/load-config.js';
import { deriveLogIdFromCardId } from '../server/chat-flow/copilot-chat/watchparty.js';
import { readEnhancedChatMessages } from '../server/chat-flow/copilot-chat/shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, 'queue-runner.config.json');

function createLogger(scope) {
  return {
    info: (msg, ...args) => console.log(`[${scope}] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[${scope}] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${scope}] ${msg}`, ...args),
  };
}

async function maybeLoadTaskExecutor(boardId, boardConfig, configDir) {
  if (!boardConfig.taskExecutorModule) return undefined;
  const absolutePath = resolveConfigRelativePath(configDir, boardConfig.taskExecutorModule);
  const mod = await import(pathToFileURL(absolutePath).href);
  if (typeof mod.executeTaskExecutorRequest !== 'function') {
    throw new Error(`Task executor module for ${boardId} must export executeTaskExecutorRequest(request)`);
  }
  return mod.executeTaskExecutorRequest;
}

function normalizePositiveInt(value, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function resolveInvokeTimeoutMs(flow) {
  return normalizePositiveInt(flow?.settings?.invoke_timeout_ms, 300000) ?? 300000;
}

function executionWhatToRunValue(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const raw = ref.whatToRun;
  if (raw && typeof raw === 'object' && typeof raw.value === 'string') return raw.value;
  return '';
}

async function runChatHandlerFlow(flowSpec, args) {
  const flow = await loadStepFlow(flowSpec);
  const handlers = buildStepHandlersForFlow(flow, {
    invoke: (ref, stepArgs) => invokeExecutionRef(ref, stepArgs, {
      cliDir: BOARD_ROOT,
      cwd: BOARD_ROOT,
      timeoutMs: resolveInvokeTimeoutMs(flow),
      label: 'chat-handler',
    }),
  });
  const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
  const run = await machine.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {});
  if (run.status !== 'completed') {
    const reason = run.error?.message ?? run.intent ?? run.status;
    return { dispatched: false, error: String(reason || 'flow execution failed') };
  }
  if (run.intent !== 'success') {
    const reason = typeof run.data?.error === 'string'
      ? run.data.error
      : `flow returned intent: ${run.intent}`;
    return { dispatched: false, error: reason };
  }
  return { dispatched: true };
}

async function deriveLastUserText(boardId, cardId, turnId, logId, lastChatEntryId) {
  const messages = await readEnhancedChatMessages(boardId, cardId, 30000, {
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
  });
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (typeof lastChatEntryId === 'string' && lastChatEntryId.trim()) {
    const exactMatch = messages.find((message) => (
      message
      && message.id === lastChatEntryId
      && message.role === 'user'
      && typeof message.text === 'string'
      && message.text.trim()
    ));
    if (exactMatch) return exactMatch.text.trim();
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.text === 'string' && message.text.trim()) {
      return message.text.trim();
    }
  }
  return '';
}

async function executeChatAgentRequest(request, boardId, chatRuntime) {
  const requestArgs = request && typeof request.args === 'object' && !Array.isArray(request.args)
    ? request.args
    : {};
  const cardId = typeof requestArgs.cardId === 'string' ? requestArgs.cardId.trim() : '';
  const turnId = typeof requestArgs.turnId === 'string' ? requestArgs.turnId.trim() : '';
  const logId = typeof requestArgs.logId === 'string' && requestArgs.logId.trim()
    ? requestArgs.logId.trim()
    : deriveLogIdFromCardId(cardId);
  const userText = typeof requestArgs.userText === 'string' && requestArgs.userText.trim()
    ? requestArgs.userText.trim()
    : await deriveLastUserText(boardId, cardId, turnId, logId, requestArgs.lastChatEntryId);
  const args = {
    ...chatRuntime.executionExtra,
    ...requestArgs,
    ...(cardId ? { cardId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
    ...(userText ? { userText } : {}),
  };

  const ref = request?.ref;
  const result = ref?.howToRun === 'built-in' && executionWhatToRunValue(ref) === 'chat-handler-flow-queue'
    ? await runChatHandlerFlow(chatRuntime.chatHandlerFlow, args)
    : await invokeExecutionRef(ref, args, {
      cliDir: BOARD_ROOT,
      cwd: BOARD_ROOT,
      timeoutMs: 300000,
      label: 'chat-handler',
    }).then((output) => ({
      dispatched: output?.result === 'success',
      error: output?.error,
    }));

  if (!result.dispatched) {
    throw new Error(result.error || `chat-agent dispatch failed for card "${cardId || 'unknown'}"`);
  }
}

async function postMcp(url, tool, args = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string'
      ? payload.error
      : raw || response.statusText || `HTTP ${response.status}`;
    throw new Error(`${tool} failed: ${message}`);
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.status === 'fail' || payload.status === 'error') {
      throw new Error(payload.error || `${tool} returned ${payload.status}`);
    }
  }

  return payload;
}

function applyLaneTuning(lane, tuning) {
  if (!tuning || typeof tuning !== 'object') return lane;
  return {
    ...lane,
    ...(tuning.pollIntervalMs != null ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
    ...(tuning.visibilityMs != null ? { visibilityMs: tuning.visibilityMs } : {}),
    ...(tuning.concurrency != null ? { concurrency: tuning.concurrency } : {}),
    ...(tuning.maxAttempts != null ? { maxAttempts: tuning.maxAttempts } : {}),
  };
}

function createQueueStorageLane(id, queue, handleMessage, onError) {
  return {
    id,
    async lease(opts) {
      const leased = await queue.lease(opts);
      return leased.map((lease) => ({
        id: lease.id,
        attempt: lease.attempt,
        message: lease.body,
        ack: () => queue.ack(lease.id, lease.leaseToken),
        nack: (nackOpts) => queue.nack(lease.id, lease.leaseToken, nackOpts),
      }));
    },
    async handle() {
      await handleMessage();
    },
    onError,
  };
}

function createBoardWorkerLane(id, store, handleRequest, onError) {
  return {
    id,
    async lease(opts) {
      const leased = await store.leaseRequests(opts);
      return leased.map((lease) => ({
        id: lease.messageId,
        attempt: lease.attempt,
        message: lease.request,
        ack: () => store.ackRequest(lease.messageId, lease.leaseToken),
        nack: (nackOpts) => store.nackRequest(lease.messageId, lease.leaseToken, nackOpts),
      }));
    },
    async handle(message) {
      await handleRequest(message);
    },
    onError,
  };
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
        await taskExecutor(request.args, request);
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

async function runLaneLease(lane, lease) {
  try {
    await lane.handle(lease.message, lease);
    await lease.ack();
  } catch (error) {
    const dead = lease.attempt >= Math.max(1, Math.floor(lane.maxAttempts ?? 5));
    await lease.nack({
      dead,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (typeof lane.onError === 'function') {
      lane.onError(error, lease);
    }
  }
}

async function drainLaneToIdle(lane, maxPasses = 256) {
  const visibilityMs = Math.max(1, Math.floor(lane.visibilityMs ?? 60_000));
  const concurrency = Math.max(1, Math.floor(lane.concurrency ?? 1));
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const leases = await lane.lease({ max: concurrency, visibilityMs });
    if (!leases.length) return total;
    total += leases.length;
    for (const lease of leases) {
      await runLaneLease(lane, lease);
    }
  }
  throw new Error(`Exceeded ${maxPasses} drain passes for lane ${lane.id}`);
}

function createWakeTrigger(lane, logger) {
  let running = false;
  let pending = false;

  async function drain() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await drainLaneToIdle(lane);
      } while (pending);
    } catch (error) {
      logger.error(`lane ${lane.id} drain failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }

  return () => {
    void drain();
  };
}

function queueCollectionPath(boardId, laneId) {
  if (laneId === 'process-accumulated') return `boards/${boardId}/process-queue`;
  if (laneId === 'chat-agent') return `boards/${boardId}/chat-queue`;
  return `boards/${boardId}/worker-queue`;
}

async function main() {
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH);
  const firebaseServices = await initializeFirebaseServices(hostConfig.firebase);
  const stopSubscriptions = [];

  for (const [boardId, boardConfig] of Object.entries(hostConfig.boards)) {
    const logger = createLogger(`queue:${boardId}`);
    const callbackServerOrigin = hostConfig.serverOrigin || 'http://127.0.0.1:7810';
    const apiBaseUrl = `${callbackServerOrigin}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`;
    const webhooksUrl = `${apiBaseUrl}/mcp-webhooks`;
    const controlplaneUrl = `${apiBaseUrl}/mcp-controlplane`;
    const bundle = buildBoardBundle(
      boardId,
      boardConfig,
      firebaseServices,
      {},
      { callbackTransport: createHttpBoardCallbackTransport(webhooksUrl) },
    );
    const taskExecutor = await maybeLoadTaskExecutor(boardId, boardConfig, hostConfig.configDir);
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

    for (const lane of lanes) {
      const trigger = createWakeTrigger(lane, logger);
      const unsubscribe = firebaseServices.firestore
        .collection(queueCollectionPath(boardId, lane.id))
        .onSnapshot(
          () => trigger(),
          (error) => logger.error(`snapshot failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`),
        );
      stopSubscriptions.push(unsubscribe);
      trigger();
    }
  }

  console.log(`[queue-runner-firebase] Watching ${Object.keys(hostConfig.boards).length} board(s)`);

  function shutdown() {
    for (const stop of stopSubscriptions.splice(0)) {
      try {
        stop();
      } catch {
        // ignore shutdown errors
      }
    }
    setTimeout(() => process.exit(0), 0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[queue-runner-firebase] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
