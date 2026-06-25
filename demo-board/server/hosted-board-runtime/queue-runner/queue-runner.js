#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostedBoardQueueLaneRegistry, createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport, createInProcessBoardCallbackTransport } from 'yaml-flow/board-live-cards-node';
import { loadLocalFsHostConfig, resolveConfigRelativePath } from '../localfs-adapter/load-config.js';
import { createDynamicBoards } from '../boards-index/dynamic-boards.js';
import { buildBoardBundle as buildLocalFsBoardBundle } from '../localfs-adapter/build-board-bundle.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import { buildHostedBoardRuntimeNeeds, executeChatAgentRequest } from '../host-shared/chat-agent-handler/execute-chat-agent-request.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../host-shared/logging.js';
import {
  createHostedImmediateTaskExecutorRef,
  loadTaskExecutorModule,
} from '../host-shared/worker-modules/task-executor-module.js';
import { createWakeTrigger, queueCollectionPath, startLaneRunners } from '../host-shared/lanes/runtime.js';
import {
  boardSourceFetchCallbackKey,
  isEmbeddedHost,
} from '../host-shared/in-process-source-fetch-callback.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load hosted-board-runtime/.env (if present) for local Foundry overrides.
// See .env.template for supported variables. Real values stay local; .env is gitignored.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
  } catch {
    // No .env present (or unreadable); explicit environment variables still apply.
  }
}

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'hosted-board-runtime.localfs.config.json');

function readPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function boardConfigSignature(boardConfig) {
  return JSON.stringify(boardConfig ?? null);
}

function defaultQueueRunnerConcurrency() {
  if (typeof os.availableParallelism === 'function') {
    return Math.max(1, os.availableParallelism());
  }
  return Math.max(1, os.cpus().length || 1);
}

function resolveAssistantDerivedVisibilityMs(hostConfig) {
  const assistantTimeoutMs = Math.max(
    readPositiveInt(hostConfig?.chatCopilotTimeoutMs, 2100000),
    readPositiveInt(hostConfig?.chatFlowTimeoutMs, 0),
    readPositiveInt(hostConfig?.chatInvokeRefTimeoutMs, 0),
  );

  return assistantTimeoutMs + 60000;
}

function resolveLaneVisibilityMs(envValue, configValue, assistantDerivedMs) {
  const explicit = readPositiveInt(envValue, readPositiveInt(configValue, 0));
  return explicit > 0 ? explicit : assistantDerivedMs;
}

function buildHostedQueueLaneTuning(hostConfig) {
  const defaultConcurrency = readPositiveInt(
    process.env.DEMO_BOARDS_QUEUE_CONCURRENCY,
    readPositiveInt(hostConfig?.queueConcurrency, defaultQueueRunnerConcurrency()),
  );
  const fallbackPollIntervalMs = readPositiveInt(
    process.env.DEMO_BOARDS_QUEUE_FALLBACK_POLL_MS,
    readPositiveInt(hostConfig?.queueFallbackPollMs, 3000),
  );
  // All lanes can run AI-backed work that may take up to the assistant timeout,
  // so their lease visibility defaults to that timeout (+60s) to avoid a lease
  // expiring mid-run and the message being reclaimed and re-executed. Each lane
  // can still be overridden independently from the hosted config or env.
  const assistantDerivedVisibilityMs = resolveAssistantDerivedVisibilityMs(hostConfig);
  const shared = {
    concurrency: defaultConcurrency,
    pollIntervalMs: fallbackPollIntervalMs,
  };
  return {
    processAccumulated: {
      ...shared,
      visibilityMs: resolveLaneVisibilityMs(
        process.env.DEMO_BOARDS_PROCESS_ACCUMULATED_VISIBILITY_MS,
        hostConfig?.processAccumulatedVisibilityMs,
        assistantDerivedVisibilityMs,
      ),
    },
    chatAgent: {
      ...shared,
      visibilityMs: resolveLaneVisibilityMs(
        process.env.DEMO_BOARDS_CHAT_AGENT_VISIBILITY_MS,
        hostConfig?.chatAgentVisibilityMs,
        assistantDerivedVisibilityMs,
      ),
    },
    taskExecutor: {
      ...shared,
      visibilityMs: resolveLaneVisibilityMs(
        process.env.DEMO_BOARDS_TASK_EXECUTOR_VISIBILITY_MS,
        hostConfig?.taskExecutorVisibilityMs,
        assistantDerivedVisibilityMs,
      ),
    },
  };
}

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
    normalizeText(sourceDef?.kind) ? `kind=${normalizeText(sourceDef.kind)}` : '',
    normalizeText(sourceDef?.bindTo) ? `bindTo=${normalizeText(sourceDef.bindTo)}` : '',
    normalizeText(sourceDef?.outputFile) ? `outputFile=${normalizeText(sourceDef.outputFile)}` : '',
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

function runtimeNotificationsFromSsePayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    return payload.notifications;
  }
  return [];
}

function drainWakeTriggersFromNotifications(notifications, wakeTriggers) {
  let triggered = false;
  for (const notification of notifications) {
    if (!notification || typeof notification !== 'object') continue;
    if (notification.kind !== 'message_enqueued') continue;
    const lane = normalizeText(notification.lane);
    if (!lane) continue;
    const wakeTrigger = wakeTriggers.get(lane);
    if (!wakeTrigger) continue;
    wakeTrigger();
    triggered = true;
  }
  return triggered;
}

function createSseWakeSubscriber({ boardId, sseUrl, wakeTriggers, logger }) {
  const clientId = `queue-runner-${process.pid}-${boardId}`;
  const reconnectDelayMs = 1000;
  let stopped = false;
  let activeRequest = null;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function handlePayload(payload) {
    const notifications = runtimeNotificationsFromSsePayload(payload);
    if (notifications.length === 0) return;
    const triggered = drainWakeTriggersFromNotifications(notifications, wakeTriggers);
    if (triggered) {
      trace(`queue-wake board=${boardId} notifications=${notifications.length}`);
    }
  }

  function connect() {
    if (stopped) return;
    const targetUrl = new URL(sseUrl);
    targetUrl.searchParams.set('clientId', clientId);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const request = transport.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    activeRequest = request;
    request.on('response', (response) => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        logger.warn(`[queue-runner] SSE subscribe failed for ${boardId}: HTTP ${response.statusCode || 0}`);
        response.resume();
        scheduleReconnect();
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
          const frameBoundary = buffer.indexOf('\n\n');
          if (frameBoundary < 0) break;
          const frame = buffer.slice(0, frameBoundary);
          buffer = buffer.slice(frameBoundary + 2);
          const dataLines = frame
            .split(/\r?\n/g)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          try {
            handlePayload(JSON.parse(dataLines.join('\n')));
          } catch {
            // Ignore malformed SSE payloads.
          }
        }
      });
      response.on('end', scheduleReconnect);
      response.on('close', scheduleReconnect);
      response.on('error', scheduleReconnect);
    });
    request.on('error', (error) => {
      logger.warn(`[queue-runner] SSE subscribe failed for ${boardId}: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
    });
    request.end();
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (activeRequest) {
      activeRequest.destroy();
      activeRequest = null;
    }
  };
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

function createExplicitQueueLanes({ boardId, boardConfig, bundle, runtime, logger, taskExecutor, controlplaneUrl, serverUrl, notifyServerUrl, notifyUrl, watchpartyPublishNotifications, mcpServerUrl, apiBasePrefix, watchpartyFileRegistry }) {
  const boardRuntimeNeeds = buildHostedBoardRuntimeNeeds(boardId, boardConfig, {
    serverUrl,
    boardToolInvoker: typeof runtime?.boardToolInvoker === 'function'
      ? runtime.boardToolInvoker
      : null,
    notifyServerUrl,
    notifyUrl,
    watchpartyPublishNotifications,
    mcpServerUrl,
    apiBasePrefix,
    configDir: runtime.configDir,
    foundryAgents: runtime.foundryAgents,
    chatFlowTimeoutMs: runtime.chatFlowTimeoutMs,
    chatInvokeRefTimeoutMs: runtime.chatInvokeRefTimeoutMs,
    chatCopilotTimeoutMs: runtime.chatCopilotTimeoutMs,
    watchpartyFileRegistry,
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
            trace(`tt-dummy-picked-up board=${boardId}${marker ? ` marker=${marker}` : ''}`);
            return;
          }
          const executorRequest = args && typeof args === 'object' && !Array.isArray(args)
            ? {
                ...args,
                ...(request.output ? { output: request.output } : {}),
                ...(request.diagnostics ? { diagnostics: request.diagnostics } : {}),
                ...(request.callback ? { callback: request.callback } : {}),
                extra: {
                  ...(boardRuntimeNeeds?.taskExecutorExtra && typeof boardRuntimeNeeds.taskExecutorExtra === 'object' && !Array.isArray(boardRuntimeNeeds.taskExecutorExtra)
                    ? boardRuntimeNeeds.taskExecutorExtra
                    : {}),
                  ...(request.extra && typeof request.extra === 'object' && !Array.isArray(request.extra)
                    ? request.extra
                    : {}),
                },
              }
            : request;
          const quoteUrls = executorRequest?.source_def?._projections?.quote_urls;
          const projectedQuoteUrls = Array.isArray(quoteUrls) ? quoteUrls : null;
          trace(`task-executor-handle-start board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)} callback=${Boolean(executorRequest?.callback)} output=${Boolean(executorRequest?.output)}`);
          trace(`source projections board=${boardId} bindTo=${typeof executorRequest?.source_def?.bindTo === 'string' ? executorRequest.source_def.bindTo : ''} quoteUrlsType=${projectedQuoteUrls ? 'array' : quoteUrls === undefined ? 'missing' : typeof quoteUrls} quoteUrlsCount=${projectedQuoteUrls ? projectedQuoteUrls.length : 0} firstQuoteUrl=${projectedQuoteUrls?.[0] || ''}`);
          await taskExecutor(executorRequest);
          trace(`task-executor-handle-complete board=${boardId} hasSourceDef=${Boolean(executorRequest?.source_def)}`);
        }
      : undefined,
  });
}

function createInProcessNotificationPublisher(boardId, runtimeBoardRegistry, processLogger) {
  return async (notifications) => {
    if (!Array.isArray(notifications) || notifications.length === 0) {
      return;
    }
    const entry = runtimeBoardRegistry?.get(boardId);
    const runtime = entry?.runtime;
    if (!runtime || typeof runtime.emitNotification !== 'function') {
      throw new Error(`in-process emitNotification target missing for board ${boardId}`);
    }
    try {
      await runtime.emitNotification({
        kind: 'notification-batch',
        notifications,
      });
    } catch (error) {
      processLogger?.error?.(
        `[queue-runner] in-process notify failed for ${boardId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}

function createInProcessBoardToolInvoker(boardId, runtimeBoardRegistry) {
  return async (tool, args = {}, options = {}) => {
    const entry = runtimeBoardRegistry?.get(boardId);
    if (!entry) {
      throw new Error(`in-process board runtime missing for board ${boardId}`);
    }
    return entry.runtime.handleRuntimeApi
      ? (await import('../http-mcp-controlface/controlface-mcp-surface.js')).invokeBoardRuntimeJson(
          entry,
          { apiBasePrefix: '/api/boards', host: '127.0.0.1', port: 7799 },
          boardId,
          options?.controlplane ? 'mcp-controlplane' : 'mcp',
          { tool, args },
        )
      : null;
  };
}

export async function startQueueRunner(options = {}) {
  const processLogger = createLogger('queue-runner', { filePath: HOSTED_SERVER_LOG_PATH });
  const hostConfig = loadLocalFsHostConfig(DEFAULT_CONFIG_PATH, process.argv.slice(2), 'queueRunner');
  const queueLaneTuning = buildHostedQueueLaneTuning(hostConfig);
  const boardRefreshIntervalMs = readPositiveInt(
    process.env.DEMO_BOARDS_QUEUE_BOARD_REFRESH_MS,
    readPositiveInt(hostConfig?.queueBoardRefreshMs, 5000),
  );
  const adapterServices = await initializeLocalFsServices(hostConfig.localfs);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  const runtimeBoardRegistry = options && typeof options === 'object' && options.boardRuntimes instanceof Map
    ? options.boardRuntimes
    : null;
  const stopSubscriptions = [];
  const watchedBoards = new Map();
  let keepAliveTimer = null;
  let refreshTimer = null;
  const buildBoardBundle = buildLocalFsBoardBundle;

  function stopWatchedBoard(boardId) {
    const watched = watchedBoards.get(boardId);
    if (!watched) return;
    watchedBoards.delete(boardId);
    for (const stop of watched.stops) {
      try {
        stop();
      } catch {
      }
    }
  }

  function ensureKeepAliveTimer() {
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {}, 1 << 30);
    }
  }

  ensureKeepAliveTimer();

  function startWatchingBoard(boardConfig) {
    const boardId = boardConfig.id;
    const logger = processLogger.child(`${boardId}:queue`);
    const callbackServerOrigin = hostConfig.serverOrigin || 'http://127.0.0.1:7799';
    const apiBaseUrl = `${callbackServerOrigin}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`;
    const webhooksUrl = `${apiBaseUrl}/mcp-webhooks`;
    const controlplaneUrl = `${apiBaseUrl}/mcp-controlplane`;
    // Build the board runtime needs up front so the task-executor ref carries the
    // full execution extra (aiWorkspaceRoot, boardId, foundry handles). Source_def
    // runs (copilot/foundry) rely on aiWorkspaceRoot to run in the board's own
    // workspace and on boardId to scope liveboards.* tool calls to this board.
    const boardRuntimeNeeds = buildHostedBoardRuntimeNeeds(boardId, boardConfig, {
      serverUrl: callbackServerOrigin,
      boardToolInvoker: isEmbeddedHost() && runtimeBoardRegistry
        ? createInProcessBoardToolInvoker(boardId, runtimeBoardRegistry)
        : null,
      notifyServerUrl: callbackServerOrigin,
      notifyUrl: `${apiBaseUrl}/notify-q`,
      watchpartyPublishNotifications: isEmbeddedHost() && runtimeBoardRegistry
        ? createInProcessNotificationPublisher(boardId, runtimeBoardRegistry, processLogger)
        : null,
      mcpServerUrl: hostConfig.mcpServerUrl,
      apiBasePrefix: hostConfig.apiBasePrefix,
      configDir: hostConfig.configDir,
      foundryAgents: hostConfig.foundryAgents,
      chatFlowTimeoutMs: hostConfig.chatFlowTimeoutMs,
      chatInvokeRefTimeoutMs: hostConfig.chatInvokeRefTimeoutMs,
      chatCopilotTimeoutMs: hostConfig.chatCopilotTimeoutMs,
      taskExecutorTimeoutMs: hostConfig.taskExecutorTimeoutMs,
      watchpartyFileRegistry: adapterServices?.watchpartyFileRegistry,
    });
    const bundle = buildBoardBundle(
      boardId,
      boardConfig,
      adapterServices,
      isEmbeddedHost() && runtimeBoardRegistry
        ? {
            publishBoardChangeNotifications: createInProcessNotificationPublisher(
              boardId,
              runtimeBoardRegistry,
              processLogger,
            ),
          }
        : {},
      {
        callbackTransport: isEmbeddedHost()
          ? createInProcessBoardCallbackTransport(boardSourceFetchCallbackKey(boardId))
          : createHttpBoardCallbackTransport(webhooksUrl),
        configDir: hostConfig.configDir,
        taskExecutorRef: createHostedImmediateTaskExecutorRef(boardId, boardRuntimeNeeds.taskExecutorExtra),
        resolveConfigRelativePath,
      },
    );
    const taskExecutor = loadTaskExecutorModule();
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`,
      boardId,
      boards: [bundle.boardContextConfig],
      queueLaneTuning,
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
        boardToolInvoker: isEmbeddedHost() && runtimeBoardRegistry
          ? createInProcessBoardToolInvoker(boardId, runtimeBoardRegistry)
          : null,
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
      notifyServerUrl: callbackServerOrigin,
      notifyUrl: `${apiBaseUrl}/notify-q`,
      watchpartyPublishNotifications: isEmbeddedHost() && runtimeBoardRegistry
        ? createInProcessNotificationPublisher(boardId, runtimeBoardRegistry, processLogger)
        : null,
      mcpServerUrl: hostConfig.mcpServerUrl,
      apiBasePrefix: hostConfig.apiBasePrefix,
      watchpartyFileRegistry: adapterServices?.watchpartyFileRegistry,
    }), boardId, processLogger);

    const wakeTriggers = new Map(
      laneRegistry.lanes.map((lane) => [lane.id, createWakeTrigger(lane, logger)]),
    );

    const stops = [];
    const stopRunner = startLaneRunners(laneRegistry);
    stops.push(stopRunner);
    stops.push(createSseWakeSubscriber({
      boardId,
      sseUrl: `${callbackServerOrigin}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}/sse-q`,
      wakeTriggers,
      logger,
    }));
    watchedBoards.set(boardId, {
      signature: boardConfigSignature(boardConfig),
      stops,
    });
    ensureKeepAliveTimer();
    processLogger.info(`[queue-runner] watching board ${boardId}`);
  }

  async function reconcileBoards() {
    const boardConfigs = await dynamicBoards.list();
    const nextBoardIds = new Set(boardConfigs.map((boardConfig) => boardConfig.id));

    for (const [boardId] of watchedBoards) {
      if (!nextBoardIds.has(boardId)) {
        stopWatchedBoard(boardId);
        processLogger.info(`[queue-runner] stopped watching removed board ${boardId}`);
      }
    }

    for (const boardConfig of boardConfigs) {
      const signature = boardConfigSignature(boardConfig);
      const watched = watchedBoards.get(boardConfig.id);
      if (!watched) {
        startWatchingBoard(boardConfig);
        continue;
      }
      if (watched.signature === signature) {
        continue;
      }
      stopWatchedBoard(boardConfig.id);
      startWatchingBoard(boardConfig);
      processLogger.info(`[queue-runner] reloaded board ${boardConfig.id}`);
    }
  }

  await reconcileBoards();
  refreshTimer = setInterval(() => {
    void reconcileBoards().catch((error) => {
      processLogger.error(`[queue-runner] board refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, boardRefreshIntervalMs);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }

  function shutdown() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    for (const boardId of [...watchedBoards.keys()]) {
      stopWatchedBoard(boardId);
    }
    for (const stop of stopSubscriptions.splice(0)) {
      try {
        stop();
      } catch {
      }
    }
    if (typeof adapterServices?.watchpartyFileRegistry?.dispose === 'function') {
      try {
        adapterServices.watchpartyFileRegistry.dispose();
      } catch {
      }
    }
    setTimeout(() => process.exit(0), 0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { shutdown, reconcileBoards };
}

const isQueueRunnerEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isQueueRunnerEntrypoint) {
  startQueueRunner().catch((error) => {
    const processLogger = createLogger('queue-runner', { filePath: HOSTED_SERVER_LOG_PATH });
    processLogger.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
