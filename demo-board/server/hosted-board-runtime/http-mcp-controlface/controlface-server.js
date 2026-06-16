#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport } from 'yaml-flow/board-live-cards-node';
import { buildBoardBundle as buildFirebaseBoardBundle } from '../firebase-adapter/build-board-bundle.js';
import { initializeFirebaseServices } from '../firebase-adapter/firebase-init.js';
import { loadFirebaseHostConfig, resolveConfigRelativePath } from '../firebase-adapter/load-config.js';
import { createBoardLayoutsStore } from '../board-layouts/layout-store.js';
import { createDynamicBoards } from '../boards-index/dynamic-boards.js';
import { buildBoardBundle as buildLocalFsBoardBundle } from '../localfs-adapter/build-board-bundle.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import {
  buildHostedBoardRuntimeNeeds,
  executeChatAgentRequest,
} from '../host-shared/chat-agent-handler/execute-chat-agent-request.js';
import {
  boardNeedsAiWorkspaceSetup,
  runSetupSingleAiWorkspaceScript,
} from '../host-shared/ai-workspace-setup.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../host-shared/logging.js';
import {
  createHostedImmediateTaskExecutorRef,
  loadTaskExecutorModule,
} from '../host-shared/worker-modules/task-executor-module.js';
import {
  getSampleTemplateEnvelope,
  listSampleTemplateEntries,
} from '../host-shared/mcp-extras/sample-template-catalog.js';
import {
  emitWatchpartyToolsNotification,
  invokeBoardRuntimeJson,
  normalizeMcpArgs,
  readMcpArg,
  stripLogIdFromMcpBody,
  createControlfaceMcpSurface,
} from './controlface-mcp-surface.js';
import { createAgentMcpHandler, AGENT_MCP_PATHS } from './agentface-mcp.js';
import { WATCHPARTY_AGENT_TOOL_ACTIONS } from '../../../shared/watchparty-agent-tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load hosted-board-runtime/.env (if present) for local Firebase/Foundry overrides.
// See .env.template for supported variables. Real values stay local; .env is gitignored.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
  } catch {
    // No .env present (or unreadable); explicit environment variables still apply.
  }
}

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'hosted-board-runtime.localfs.config.json');
const SETUP_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-single-ai-workspace.js');
function readPositiveIntValue(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function resolveAssistantDerivedVisibilityMs(hostConfig) {
  const assistantTimeoutMs = Math.max(
    readPositiveIntValue(hostConfig?.chatCopilotTimeoutMs, 2100000),
    readPositiveIntValue(hostConfig?.chatFlowTimeoutMs, 0),
    readPositiveIntValue(hostConfig?.chatInvokeRefTimeoutMs, 0),
  );

  return assistantTimeoutMs + 60000;
}

function resolveLaneVisibilityMs(configValue, assistantDerivedMs) {
  const explicit = readPositiveIntValue(configValue, 0);
  return explicit > 0 ? explicit : assistantDerivedMs;
}

function buildHostedQueueLaneTuning(hostConfig) {
  // Every lane can run AI-backed work bounded by the assistant timeout, so each
  // lane's lease visibility defaults to that timeout (+60s) and can be overridden
  // independently from the hosted config.
  const assistantDerivedVisibilityMs = resolveAssistantDerivedVisibilityMs(hostConfig);
  return {
    processAccumulated: {
      visibilityMs: resolveLaneVisibilityMs(hostConfig?.processAccumulatedVisibilityMs, assistantDerivedVisibilityMs),
    },
    chatAgent: {
      concurrency: 2,
      visibilityMs: resolveLaneVisibilityMs(hostConfig?.chatAgentVisibilityMs, assistantDerivedVisibilityMs),
    },
    taskExecutor: {
      visibilityMs: resolveLaneVisibilityMs(hostConfig?.taskExecutorVisibilityMs, assistantDerivedVisibilityMs),
    },
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function matchBoardRoute(apiBasePrefix, pathname) {
  const prefix = String(apiBasePrefix || '').replace(/\/$/, '');
  const pattern = new RegExp(`^${escapeRegex(prefix)}/([^/]+)(?:/|$)`);
  return pattern.exec(pathname);
}

function joinParts(parts) {
  return parts.filter((part) => typeof part === 'string' && part.trim()).join(' ');
}

function defaultBoardId(boardRuntimes) {
  return Array.from(boardRuntimes.keys())[0] || '';
}

function normalizeControlfaceScope(routeKind, boardId, boardRuntimes) {
  const resolvedBoardId = normalizeText(boardId) || defaultBoardId(boardRuntimes) || 'controlface';
  if (routeKind === 'agent-mcp') {
    return `${resolvedBoardId}:agentface`;
  }
  return `${resolvedBoardId}:controlface`;
}

function resolveControlfaceRouteLabel(parsedUrl, details = {}) {
  const pathname = normalizeText(parsedUrl?.pathname);
  if (!pathname) {
    return '/';
  }
  if (details.routeKind === 'agent-mcp' && pathname.startsWith('/agent/')) {
    return pathname;
  }
  const segments = pathname.split('/').filter(Boolean);
  const stem = segments[segments.length - 1] || '';
  return stem ? `/${stem}` : '/';
}

function formatMcpRequestDetails(details = {}) {
  const sessionId = normalizeText(details.sessionId);
  return [
    normalizeText(details.toolName) || normalizeText(details.rpcMethod),
    normalizeText(details.cardId),
    normalizeText(details.turnId),
    sessionId ? `session=${sessionId}` : '',
  ];
}

function formatControlfacePickupMessage(req, parsedUrl, details = {}) {
  const method = normalizeText(req?.method) || 'GET';
  const routeLabel = resolveControlfaceRouteLabel(parsedUrl, details);
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions' || details.routeKind === 'mcp-extras' || details.routeKind === 'agent-mcp') {
    return joinParts([method, routeLabel, ...formatMcpRequestDetails(details)]);
  }
  return joinParts([method, routeLabel]);
}

function formatControlfaceCompletionMessage(req, parsedUrl, details = {}, statusCode = 0) {
  const method = normalizeText(req?.method) || 'GET';
  const status = String(statusCode || 0);
  const routeLabel = resolveControlfaceRouteLabel(parsedUrl, details);
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions' || details.routeKind === 'mcp-extras' || details.routeKind === 'agent-mcp') {
    return joinParts([method, routeLabel, ...formatMcpRequestDetails(details), status, normalizeText(details.errorMessage)]);
  }
  return joinParts([method, routeLabel, status, normalizeText(details.errorMessage)]);
}

function readRawRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonObjectOrEmpty(buffer) {
  try {
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    if (!text.trim()) {
      return {};
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readMcpSessionIdHeader(req) {
  const raw = req?.headers?.['mcp-session-id'];
  return normalizeText(Array.isArray(raw) ? raw[0] : raw);
}

function createReplayableRequest(req, rawBodyBuffer) {
  const replayReq = Readable.from(rawBodyBuffer.length > 0 ? [rawBodyBuffer] : []);
  replayReq.method = req.method;
  replayReq.url = req.url;
  replayReq.headers = req.headers;
  replayReq.httpVersion = req.httpVersion;
  return replayReq;
}

function isBoardSseConnectRequest(req, parsedUrl, boardId, apiBasePrefix) {
  if ((req?.method || '').toUpperCase() !== 'GET') return false;
  const normalizedBoardId = normalizeText(boardId);
  if (!normalizedBoardId) return false;
  const expectedPath = `${String(apiBasePrefix || '').replace(/\/$/, '')}/${encodeURIComponent(normalizedBoardId)}/sse`;
  return normalizeText(parsedUrl?.pathname) === expectedPath;
}

function fireAndForgetProcessAccumulated(entry, hostConfig, boardId, logger) {
  void invokeBoardRuntimeJson(entry, hostConfig, boardId, 'mcp-webhooks', {
    tool: 'webhook.process-accumulated',
    args: {},
  }).catch((error) => {
    logger.warn(`[controlface] fire-and-forget process-accumulated failed for ${boardId}: ${error?.message || error}`);
  });
}

function parseBoardPayloadEnvelope(payload) {
  if (Array.isArray(payload)) {
    return { label: '', subtitle: '', cards: payload };
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.cards)) {
    return {
      label: typeof payload.boardLabel === 'string' ? payload.boardLabel.trim() : '',
      subtitle: typeof payload.boardSubtitle === 'string' ? payload.boardSubtitle.trim() : '',
      cards: payload.cards,
    };
  }
  return null;
}

function buildBoardImportPreview(currentCards, nextCards, mode = 'replace') {
  const currentCardMap = new Map(
    (Array.isArray(currentCards) ? currentCards : [])
      .map((card) => [String(card?.id || '').trim(), card])
      .filter(([id]) => id),
  );
  const nextCardMap = new Map(
    (Array.isArray(nextCards) ? nextCards : [])
      .map((card) => [String(card?.id || '').trim(), card])
      .filter(([id]) => id),
  );
  const replaceIds = [];
  const addIds = [];
  const removeIds = [];

  for (const [id, card] of nextCardMap.entries()) {
    const title = typeof card?.meta?.title === 'string' ? card.meta.title.trim() : '';
    if (currentCardMap.has(id)) {
      replaceIds.push({ id, title });
    } else {
      addIds.push({ id, title });
    }
  }

  if (mode === 'replace') {
    for (const [id, card] of currentCardMap.entries()) {
      if (!nextCardMap.has(id)) {
        const title = typeof card?.meta?.title === 'string' ? card.meta.title.trim() : '';
        removeIds.push({ id, title });
      }
    }
  }

  replaceIds.sort((left, right) => left.id.localeCompare(right.id));
  addIds.sort((left, right) => left.id.localeCompare(right.id));
  removeIds.sort((left, right) => left.id.localeCompare(right.id));
  return { replaceIds, addIds, removeIds };
}

async function validateImportCards(boardEntry, hostConfig, boardId, cards) {
  const results = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const summary = summarizeCardForImport(card);
    const issues = [];
    let isValid = false;

    if (!summary.id) {
      issues.push('Every card in the runtime dump must have a non-empty string id');
    } else {
      try {
        const payload = await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp', {
          tool: 'preflight.validate-candidate-card-definition',
          args: {
            candidate_card_content: card,
          },
        });
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        isValid = data?.isValid === true;
        if (Array.isArray(data?.issues)) {
          for (const issue of data.issues) {
            if (typeof issue === 'string' && issue.trim()) {
              issues.push(issue.trim());
            }
          }
        }
      } catch (err) {
        const message = typeof err?.message === 'string' ? err.message.trim() : '';
        if (message) {
          issues.push(message);
        }
      }
    }

    results.push({
      id: summary.id,
      title: summary.title,
      isValid: isValid && issues.length === 0,
      issues,
    });
  }
  return results;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchLoggedMcpRoute(apiBasePrefix, pathname) {
  const prefix = String(apiBasePrefix || '').replace(/\/$/, '');
  const pattern = new RegExp(`^${escapeRegex(prefix)}/([^/]+)/(mcp|mcp-controlplane|mcp-actions)$`);
  return pattern.exec(pathname);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-file-name',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(body);
}

function readErrorMessageFromPayloadText(text) {
  const bodyText = typeof text === 'string' ? text.trim() : '';
  if (!bodyText) return '';
  try {
    const payload = JSON.parse(bodyText);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error.trim();
      }
      if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
        const nestedError = payload.data.error;
        if (typeof nestedError === 'string' && nestedError.trim()) {
          return nestedError.trim();
        }
      }
    }
  } catch {
    return bodyText;
  }
  return '';
}

function installResponseErrorCapture(res, requestDetailsRef) {
  if (!res || res.__controlfaceErrorCaptureInstalled) {
    return;
  }
  res.__controlfaceErrorCaptureInstalled = true;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];

  function captureChunk(chunk, encoding) {
    if (chunk === undefined || chunk === null) {
      return;
    }
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      return;
    }
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
  }

  function maybeCaptureErrorMessage() {
    const requestDetails = requestDetailsRef();
    if (!requestDetails || requestDetails.errorMessage || (res.statusCode || 0) < 400 || chunks.length === 0) {
      return;
    }
    const message = readErrorMessageFromPayloadText(Buffer.concat(chunks).toString('utf8'));
    if (message) {
      requestDetails.errorMessage = message;
    }
  }

  res.write = function patchedWrite(...args) {
    captureChunk(args[0], args[1]);
    return originalWrite(...args);
  };

  res.end = function patchedEnd(...args) {
    captureChunk(args[0], args[1]);
    maybeCaptureErrorMessage();
    return originalEnd(...args);
  };
}

function createNamedPipeNotificationTransport() {
  const activeClosers = new Set();
  const SERVER_CLOSE_TIMEOUT_MS = 2000;

  async function closeServer(server, pipePath, sockets) {
    // Destroy any live client connections (e.g. the queue-runner's persistent
    // pipe client) first; otherwise server.close()'s callback never fires on a
    // named pipe, which would hang the caller (e.g. deprecate-board).
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // Best-effort client teardown.
      }
    }
    sockets.clear();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, SERVER_CLOSE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(pipePath, { force: true });
      } catch {
        // Best-effort socket cleanup.
      }
    }
  }

  return {
    async subscribe(ref, onEvent) {
      if (ref?.kind !== 'named-pipe') return () => {};
      const pipePath = typeof ref.value === 'string' ? ref.value : '';
      if (!pipePath) return () => {};
      if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
        try {
          fs.rmSync(pipePath, { force: true });
        } catch {
          // Best-effort stale socket cleanup.
        }
      }
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => {
          sockets.delete(socket);
        });
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          while (true) {
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex < 0) break;
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              onEvent(parsed?.notification ?? parsed);
            } catch {
              // Ignore malformed notification frames.
            }
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => resolve());
      });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        activeClosers.delete(close);
        await closeServer(server, pipePath, sockets);
      };
      activeClosers.add(close);
      return () => {
        void close();
      };
    },
    async closeAll() {
      const closers = Array.from(activeClosers);
      await Promise.allSettled(closers.map((close) => close()));
    },
  };
}

async function disposeBoardRuntimeEntry(boardRuntimeEntry, processLogger, boardId = '') {
  if (!boardRuntimeEntry || typeof boardRuntimeEntry !== 'object') {
    return;
  }
  if (typeof boardRuntimeEntry.close !== 'function') {
    return;
  }
  try {
    await boardRuntimeEntry.close();
  } catch (error) {
    processLogger?.warn?.(`[controlface] Failed to close board runtime '${boardId}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function upsertBoardRuntimeEntry(boardRuntimes, boardId, nextEntry, processLogger) {
  const previous = boardRuntimes.get(boardId);
  if (previous) {
    await disposeBoardRuntimeEntry(previous, processLogger, boardId);
  }
  boardRuntimes.set(boardId, nextEntry);
}

async function buildSingleBoardRuntime(hostConfig, adapterServices, boardConfig, processLogger) {
  const buildBoardBundle = hostConfig.storageAdapter === 'localfs'
    ? buildLocalFsBoardBundle
    : buildFirebaseBoardBundle;
  const boardId = boardConfig.id;
  const callbackBaseUrl = `http://${hostConfig.host}:${hostConfig.port}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}/mcp-webhooks`;
  const boardRuntimeNeeds = buildHostedBoardRuntimeNeeds(boardId, boardConfig, {
    serverUrl: `http://${hostConfig.host}:${hostConfig.port}`,
    mcpServerUrl: hostConfig.mcpServerUrl,
    apiBasePrefix: hostConfig.apiBasePrefix,
    foundryAgents: hostConfig.foundryAgents,
    chatFlowTimeoutMs: hostConfig.chatFlowTimeoutMs,
    chatInvokeRefTimeoutMs: hostConfig.chatInvokeRefTimeoutMs,
    chatCopilotTimeoutMs: hostConfig.chatCopilotTimeoutMs,
  });
  const bundle = buildBoardBundle(
    boardId,
    boardConfig,
    adapterServices,
    {},
    {
      callbackTransport: createHttpBoardCallbackTransport(callbackBaseUrl),
      configDir: hostConfig.configDir,
      taskExecutorRef: createHostedImmediateTaskExecutorRef(
        boardId,
        boardRuntimeNeeds.taskExecutorExtra,
      ),
      taskExecutorTimeoutMs: hostConfig.taskExecutorTimeoutMs,
      resolveConfigRelativePath,
    },
  );
  const notificationTransport = createNamedPipeNotificationTransport();
  const runtime = createSingleBoardServerRuntime({
    apiBasePath: `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`,
    boardId,
    boards: [{
      ...bundle.boardContextConfig,
    }],
    queueLaneTuning: buildHostedQueueLaneTuning(hostConfig),
    async handleChatAgentRequest(request) {
      await executeChatAgentRequest(request, boardId, boardRuntimeNeeds);
    },
    invocationAdapter: {
      async invoke(ref) {
        return {
          dispatched: false,
          error: `No invocation adapter configured for ${ref?.howToRun || 'unknown'}`,
        };
      },
    },
    executionExtra: boardRuntimeNeeds.taskExecutorExtra,
    logger: processLogger.child(`${boardId}:controlface`),
    notificationTransport,
  });
  return {
    runtime,
    boardRuntimeNeeds,
    async close() {
      if (typeof notificationTransport.closeAll === 'function') {
        await notificationTransport.closeAll();
      }
    },
  };
}

async function buildBoardRuntimes(hostConfig, adapterServices, dynamicBoards) {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  const runtimes = new Map();
  const boardConfigs = await dynamicBoards.list();
  for (const boardConfig of boardConfigs) {
    runtimes.set(boardConfig.id, await buildSingleBoardRuntime(hostConfig, adapterServices, boardConfig, processLogger));
  }
  return runtimes;
}

async function ensureBoardAiWorkspaceReady(boardConfig, hostConfig) {
  if (!boardNeedsAiWorkspaceSetup(boardConfig)) {
    return;
  }

  await runSetupSingleAiWorkspaceScript(SETUP_SCRIPT_PATH, boardConfig.id, hostConfig.configPath);
}

async function bootstrapConfiguredBoards({ dynamicBoards, hostConfig, adapterServices, boardRuntimes, processLogger }) {
  const entries = Object.entries(hostConfig.bootstrapSampleBoards || {});
  if (entries.length === 0) {
    return { added: 0, refreshed: 0 };
  }

  let added = 0;
  let refreshed = 0;

  for (const [boardId, record] of entries) {
    const existingBoard = await dynamicBoards.get(boardId);
    if (existingBoard) {
      await ensureBoardAiWorkspaceReady(existingBoard, hostConfig);
      const boardEntry = boardRuntimes.get(boardId) || await buildSingleBoardRuntime(hostConfig, adapterServices, existingBoard, processLogger);
      await upsertBoardRuntimeEntry(boardRuntimes, boardId, boardEntry, processLogger);
      await upsertAdminTemplateCards({ boardEntry, hostConfig, board: existingBoard });
      await applyBootstrapCardsTemplate({ boardEntry, hostConfig, dynamicBoards, boardId, record });
      refreshed += 1;
      continue;
    }

    const board = await dynamicBoards.add(boardId, record);
    await ensureBoardAiWorkspaceReady(board, hostConfig);
    const boardEntry = await buildSingleBoardRuntime(hostConfig, adapterServices, board, processLogger);
    await upsertBoardRuntimeEntry(boardRuntimes, boardId, boardEntry, processLogger);
    await upsertAdminTemplateCards({ boardEntry, hostConfig, board });
    await applyBootstrapCardsTemplate({ boardEntry, hostConfig, dynamicBoards, boardId, record });
    added += 1;
  }

  processLogger.info(`Bootstrap sample boards: added=${added} refreshed=${refreshed}`);
  return { added, refreshed };
}

function resolveBootstrapCardsTemplateKey(record) {
  return typeof record?.cardsTemplate === 'string' ? record.cardsTemplate.trim() : '';
}

function summarizeBoardForList(board) {
  return {
    id: board.id,
    label: board.label,
    ai: board.ai,
    aiWorkspaceTemplate: board.aiWorkspaceTemplate,
    uiTemplate: board.uiTemplate,
    metadata: board.metadata,
  };
}

function summarizeBoardLayout(layout) {
  return layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : null;
}

function normalizeImportMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return mode === 'ingest' ? 'ingest' : 'replace';
}

function summarizeCardForImport(card) {
  return {
    id: typeof card?.id === 'string' ? card.id.trim() : '',
    title: typeof card?.meta?.title === 'string' ? card.meta.title.trim() : '',
  };
}

function listAdminTemplateCards(board) {
  const cards = board?.ui?.['admin-cards'];
  return Array.isArray(cards) ? cards.filter((card) => card && typeof card === 'object' && !Array.isArray(card)) : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectTemplatePrivateEntries(templatePrivateSection, parentKey = '') {
  if (!isPlainObject(templatePrivateSection)) {
    return [];
  }

  return Object.entries(templatePrivateSection).flatMap(([key, value]) => {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) {
      return [];
    }

    if (normalizedKey === 'visible_controlplane_only') {
      return [];
    }

    const dottedKey = parentKey ? `${parentKey}.${normalizedKey}` : normalizedKey;
    const isAddressablePrivateKey = dottedKey.includes('.');
    if (!isPlainObject(value)) {
      return isAddressablePrivateKey ? [{ key: dottedKey, value }] : [];
    }

    const nestedEntries = collectTemplatePrivateEntries(value, dottedKey);
    if (!isAddressablePrivateKey) {
      return nestedEntries;
    }
    return nestedEntries.length > 0
      ? [{ key: dottedKey, value }, ...nestedEntries]
      : [{ key: dottedKey, value }];
  });
}

async function applyTemplatePrivateState({ boardEntry, hostConfig, boardId, cardId, card }) {
  const templatePrivate = card?.__private;
  const entries = collectTemplatePrivateEntries(templatePrivate);
  for (const entry of entries) {
    await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp-controlplane', {
      tool: 'setstate.card-private',
      args: {
        board_id: boardId,
        card_id: cardId,
        key: entry.key,
        value: entry.value,
      },
    });
  }
}

async function upsertAdminTemplateCards({ boardEntry, hostConfig, board }) {
  const boardId = typeof board?.id === 'string' ? board.id.trim() : '';
  if (!boardId) {
    throw new Error('Board id is required to upsert admin template cards');
  }

  const cards = listAdminTemplateCards(board);
  for (const card of cards) {
    const cardId = typeof card?.id === 'string' ? card.id.trim() : '';
    if (!cardId) {
      throw new Error(`Admin template card for board '${boardId}' must have a non-empty string id`);
    }

    await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp-controlplane', {
      tool: 'manage.admin-upsert-card',
      args: {
        board_id: boardId,
        card_id: cardId,
        candidate_card_content: card,
      },
    });

    await applyTemplatePrivateState({ boardEntry, hostConfig, boardId, cardId, card });
  }
}

async function listRuntimeCardsForBoard(boardEntry, hostConfig, boardId) {
  const payload = await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp-controlplane', {
    tool: 'list-runtime-cards',
    args: { board_id: boardId },
  });
  const cards = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.data?.cards) ? payload.data.cards : []);
  return Array.isArray(cards) ? cards : [];
}

async function applyBoardImport({ boardEntry, hostConfig, dynamicBoards, boardId, envelope, mode, applyBoardMetadata }) {
  const nextCards = envelope.cards;
  const currentCards = await listRuntimeCardsForBoard(boardEntry, hostConfig, boardId);
  const validation = await validateImportCards(boardEntry, hostConfig, boardId, nextCards);
  const invalidCards = validation.filter((entry) => !entry.isValid);
  if (invalidCards.length > 0) {
    const error = new Error(`Import validation failed for ${invalidCards.length} card${invalidCards.length === 1 ? '' : 's'}`);
    error.statusCode = 400;
    error.validation = {
      validCards: validation.filter((entry) => entry.isValid),
      invalidCards,
    };
    throw error;
  }
  const nextIds = new Set(nextCards.map((card) => String(card?.id || '').trim()).filter(Boolean));

  for (const card of nextCards) {
    const cardId = typeof card?.id === 'string' ? card.id.trim() : '';
    if (!cardId) {
      throw new Error('Every card in the runtime dump must have a non-empty string id');
    }
    await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp-controlplane', {
      tool: 'manage.upsert-card',
      args: {
        board_id: boardId,
        card_id: cardId,
        candidate_card_content: card,
      },
    });
  }

  if (mode === 'replace') {
    for (const card of currentCards) {
      const cardId = typeof card?.id === 'string' ? card.id.trim() : '';
      if (cardId && !nextIds.has(cardId)) {
        await invokeBoardRuntimeJson(boardEntry, hostConfig, boardId, 'mcp-controlplane', {
          tool: 'manage.remove-card',
          args: {
            board_id: boardId,
            card_id: cardId,
          },
        });
      }
    }
  }

  let board = null;
  if (applyBoardMetadata && (envelope.label || envelope.subtitle)) {
    board = await dynamicBoards.saveMeta(boardId, {
      ...(envelope.label ? { pageTitle: envelope.label } : {}),
      ...(envelope.subtitle ? { pageSubtitle: envelope.subtitle } : {}),
    });
  }

  return {
    board: board ? summarizeBoardForList(board) : null,
    preview: {
      mode,
      ...buildBoardImportPreview(currentCards, nextCards, mode),
      boardLabel: envelope.label,
      boardSubtitle: envelope.subtitle,
      validCards: validation,
      invalidCards: [],
    },
  };
}

async function applyBootstrapCardsTemplate({ boardEntry, hostConfig, dynamicBoards, boardId, record }) {
  const templateKey = resolveBootstrapCardsTemplateKey(record);
  if (!templateKey) {
    return;
  }

  const template = getSampleTemplateEnvelope(hostConfig, templateKey);
  const envelope = parseBoardPayloadEnvelope(template?.payload);
  if (!Array.isArray(envelope?.cards)) {
    throw new Error(`Bootstrap sample template '${templateKey}' must be a JSON array of cards or an object with a cards array`);
  }

  await applyBoardImport({
    boardEntry,
    hostConfig,
    dynamicBoards,
    boardId,
    envelope,
    mode: 'ingest',
    applyBoardMetadata: false,
  });
}

async function buildBoardExport(boardEntry, board, hostConfig) {
  const cards = await listRuntimeCardsForBoard(boardEntry, hostConfig, board.id);
  return {
    version: 1,
    boardId: board.id,
    exportedAt: new Date().toISOString(),
    boardLabel: typeof board?.metadata?.pageTitle === 'string' ? board.metadata.pageTitle : board.label,
    boardSubtitle: typeof board?.metadata?.pageSubtitle === 'string' ? board.metadata.pageSubtitle : '',
    cards,
  };
}

async function handleManageBoardsRoute({
  req,
  res,
  dynamicBoards,
  boardLayouts,
  hostConfig,
  adapterServices,
  boardRuntimes,
  processLogger,
}) {
  const rawBody = await readRawRequestBody(req);
  const body = parseJsonObjectOrEmpty(rawBody);
  const subcommand = typeof body?.subcommand === 'string' ? body.subcommand.trim() : '';
  const args = body?.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};

  if (subcommand === 'list-boards') {
    const list = await dynamicBoards.list();
    sendJson(res, 200, { status: 'success', data: { boards: list.map(summarizeBoardForList) } });
    return;
  }

  if (subcommand === 'get-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    sendJson(res, 200, { status: 'success', data: { board } });
    return;
  }

  if (subcommand === 'add-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    const record = args?.record;
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      sendJson(res, 400, { status: 'error', error: 'args.record is required (object)' });
      return;
    }
    let board;
    try {
      board = await dynamicBoards.add(id, record);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        sendJson(res, 400, { status: 'error', error: err.message });
        return;
      }
      throw err;
    }
    await ensureBoardAiWorkspaceReady(board, hostConfig);
    const runtimePair = await buildSingleBoardRuntime(hostConfig, adapterServices, board, processLogger);
    await upsertBoardRuntimeEntry(boardRuntimes, id, runtimePair, processLogger);
    await upsertAdminTemplateCards({ boardEntry: runtimePair, hostConfig, board });
    sendJson(res, 200, { status: 'success', data: { board: summarizeBoardForList(board) } });
    return;
  }

  if (subcommand === 'save-meta') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const metadata = args?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      sendJson(res, 400, { status: 'error', error: 'args.metadata is required (object)' });
      return;
    }
    const board = await dynamicBoards.saveMeta(id, metadata);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    sendJson(res, 200, { status: 'success', data: { board: summarizeBoardForList(board) } });
    return;
  }

  if (subcommand === 'get-layout') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    const layout = await boardLayouts.get(id);
    sendJson(res, 200, { status: 'success', data: { layout: summarizeBoardLayout(layout) } });
    return;
  }

  if (subcommand === 'save-layout') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const layout = args?.layout;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
      sendJson(res, 400, { status: 'error', error: 'args.layout is required (object)' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    await boardLayouts.set(id, layout);
    sendJson(res, 200, { status: 'success', data: { layout: summarizeBoardLayout(layout) } });
    return;
  }

  if (subcommand === 'save-board-record') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const record = args?.record;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      sendJson(res, 400, { status: 'error', error: 'args.record is required (object)' });
      return;
    }
    const board = await dynamicBoards.saveRecord(id, record);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    await ensureBoardAiWorkspaceReady(board, hostConfig);
    const runtimePair = await buildSingleBoardRuntime(hostConfig, adapterServices, board, processLogger);
    await upsertBoardRuntimeEntry(boardRuntimes, id, runtimePair, processLogger);
    await upsertAdminTemplateCards({ boardEntry: runtimePair, hostConfig, board });
    sendJson(res, 200, { status: 'success', data: { board: summarizeBoardForList(board) } });
    return;
  }

  if (subcommand === 'refresh-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    await ensureBoardAiWorkspaceReady(board, hostConfig);
    const runtimePair = boardRuntimes.get(id);
    if (!runtimePair) {
      sendJson(res, 409, { status: 'error', error: `board runtime for '${id}' is not active` });
      return;
    }
    await upsertAdminTemplateCards({ boardEntry: runtimePair, hostConfig, board });
    sendJson(res, 200, { status: 'success', data: { board: summarizeBoardForList(board) } });
    return;
  }

  if (subcommand === 'deprecate-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    // Dispose the board runtime first so its named-pipe notification servers and
    // any file handles are released before we try to archive the board's
    // workspace directory (otherwise a Windows rename can fail with EPERM).
    const runtimeEntry = boardRuntimes.get(id);
    if (runtimeEntry) {
      await disposeBoardRuntimeEntry(runtimeEntry, processLogger, id);
    }
    let archived;
    try {
      archived = await dynamicBoards.deprecate(id);
    } catch (error) {
      sendJson(res, 400, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!archived) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    await boardLayouts.remove(id);
    boardRuntimes.delete(id);
    sendJson(res, 200, {
      status: 'success',
      data: {
        board: summarizeBoardForList(archived.board),
        archiveId: archived.archiveId,
        archiveRecordPath: archived.archiveRecordPath,
        archiveWorkspaceDir: archived.archiveWorkspaceDir,
      },
    });
    return;
  }

  if (subcommand === 'export-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    const entry = boardRuntimes.get(id);
    if (!entry) {
      sendJson(res, 404, { status: 'error', error: `board runtime '${id}' not found` });
      return;
    }
    const payload = await buildBoardExport(entry, board, hostConfig);
    sendJson(res, 200, { status: 'success', data: { payload } });
    return;
  }

  if (subcommand === 'preview-import-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    const envelope = parseBoardPayloadEnvelope(args?.payload);
    if (!Array.isArray(envelope?.cards)) {
      sendJson(res, 400, { status: 'error', error: 'args.payload must be a JSON array of cards or an object with a cards array' });
      return;
    }
    const mode = normalizeImportMode(args?.mode);
    const entry = boardRuntimes.get(id);
    if (!entry) {
      sendJson(res, 404, { status: 'error', error: `board runtime '${id}' not found` });
      return;
    }
    const currentCards = await listRuntimeCardsForBoard(entry, hostConfig, id);
    const validation = await validateImportCards(entry, hostConfig, id, envelope.cards);
    const preview = {
      mode,
      ...buildBoardImportPreview(currentCards, envelope.cards, mode),
      boardLabel: envelope.label,
      boardSubtitle: envelope.subtitle,
      validCards: validation.filter((entry) => entry.isValid),
      invalidCards: validation.filter((entry) => !entry.isValid),
    };
    sendJson(res, 200, { status: 'success', data: { preview } });
    return;
  }

  if (subcommand === 'apply-import-board') {
    const id = typeof args?.boardId === 'string' ? args.boardId.trim() : '';
    if (!id) {
      sendJson(res, 400, { status: 'error', error: 'args.boardId is required' });
      return;
    }
    const board = await dynamicBoards.get(id);
    if (!board) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    const envelope = parseBoardPayloadEnvelope(args?.payload);
    if (!Array.isArray(envelope?.cards)) {
      sendJson(res, 400, { status: 'error', error: 'args.payload must be a JSON array of cards or an object with a cards array' });
      return;
    }
    const mode = normalizeImportMode(args?.mode);
    const entry = boardRuntimes.get(id);
    if (!entry) {
      sendJson(res, 404, { status: 'error', error: `board runtime '${id}' not found` });
      return;
    }
    const result = await applyBoardImport({
      boardEntry: entry,
      hostConfig,
      dynamicBoards,
      boardId: id,
      envelope,
      mode,
      applyBoardMetadata: args?.applyBoardMetadata === true,
    });
    sendJson(res, 200, { status: 'success', data: result });
    return;
  }

  sendJson(res, 400, { status: 'error', error: `unknown subcommand '${subcommand}'` });
}

async function handleMcpExtrasRoute({ rawBody, res, controlfaceMcp }) {
  const body = parseJsonObjectOrEmpty(rawBody);
  sendJson(res, 200, controlfaceMcp.executeExtrasHttp(body));
}

async function main() {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH, process.argv.slice(2), 'controlface');
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  const boardLayouts = createBoardLayoutsStore({ registry: hostConfig.runtimeBoardsRegistry, adapterServices });
  const boardRuntimes = await buildBoardRuntimes(hostConfig, adapterServices, dynamicBoards);

  const controlfaceMcp = createControlfaceMcpSurface({ hostConfig, boardRuntimes });
  const agentMcp = createAgentMcpHandler({ hostConfig, boardRuntimes, logger: processLogger });

  const server = http.createServer(async (req, res) => {
    let requestDetails = null;
    let requestLogger = processLogger.child('controlface:api');
    const parsedBaseUrl = new URL(req.url || '/', `http://${hostConfig.host}:${hostConfig.port}`);
    installResponseErrorCapture(res, () => requestDetails);
    let completionLogged = false;
    const logCompletionOnce = () => {
      if (completionLogged || !requestDetails) {
        return;
      }
      completionLogged = true;
      requestLogger.info(formatControlfaceCompletionMessage(req, parsedBaseUrl, requestDetails, res.statusCode || 0));
    };

    if (parsedBaseUrl.pathname === AGENT_MCP_PATHS.mcp || parsedBaseUrl.pathname === AGENT_MCP_PATHS.manifest) {
      let parsedAgentBody;
      requestDetails = {
        routeKind: 'agent-mcp',
        sessionId: readMcpSessionIdHeader(req),
      };
      if (parsedBaseUrl.pathname === AGENT_MCP_PATHS.mcp && req.method === 'POST') {
        const rawBody = await readRawRequestBody(req);
        parsedAgentBody = parseJsonObjectOrEmpty(rawBody);
        const params = parsedAgentBody?.params && typeof parsedAgentBody.params === 'object' && !Array.isArray(parsedAgentBody.params)
          ? parsedAgentBody.params
          : {};
        const rpcMethod = normalizeText(parsedAgentBody?.method);
        const toolName = rpcMethod === 'tools/call' && typeof params?.name === 'string'
          ? params.name.trim()
          : '';
        const args = normalizeMcpArgs(params?.arguments);
        requestDetails = {
          ...requestDetails,
          rpcMethod,
          toolName,
          cardId: normalizeText(readMcpArg(args, 'card_id', 'cardId')),
          turnId: normalizeText(readMcpArg(args, 'turn_id', 'turnId', 'turn')),
        };
      }
      requestLogger = processLogger.child(normalizeControlfaceScope('agent-mcp', '', boardRuntimes));
      requestLogger.info(formatControlfacePickupMessage(req, parsedBaseUrl, requestDetails));
      res.once('finish', logCompletionOnce);
      res.once('close', logCompletionOnce);
      try {
        await agentMcp.handleRequest(req, res, parsedBaseUrl, parsedAgentBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestDetails.errorMessage = message;
        if (!res.headersSent) {
          sendJson(res, 500, { error: message });
        }
      }
      return;
    }

    if (req.method === 'OPTIONS') {
      requestDetails = {};
      requestLogger.info(formatControlfacePickupMessage(req, parsedBaseUrl, requestDetails));
      res.once('finish', logCompletionOnce);
      res.once('close', logCompletionOnce);
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,x-file-name',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      });
      res.end();
      return;
    }

    const parsedUrl = parsedBaseUrl;
    if (req.method === 'GET' && parsedUrl.pathname === '/healthz') {
      requestDetails = { routeKind: 'healthz' };
      requestLogger = processLogger.child(normalizeControlfaceScope('healthz', '', boardRuntimes));
      requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
      res.once('finish', logCompletionOnce);
      res.once('close', logCompletionOnce);
      sendJson(res, 200, {
        ok: true,
        boards: Array.from(boardRuntimes.keys()),
      });
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/manage-boards') {
      requestDetails = { routeKind: 'manage-boards' };
      requestLogger = processLogger.child(normalizeControlfaceScope('manage-boards', '', boardRuntimes));
      requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
      res.once('finish', logCompletionOnce);
      res.once('close', logCompletionOnce);
      try {
        await handleManageBoardsRoute({
          req,
          res,
          dynamicBoards,
          boardLayouts,
          hostConfig,
          adapterServices,
          boardRuntimes,
          processLogger,
        });
      } catch (err) {
        const statusCode = Number.isInteger(err?.statusCode) && err.statusCode >= 400 ? err.statusCode : 500;
        const payload = {
          status: 'error',
          error: typeof err?.message === 'string' && err.message.trim()
            ? err.message.trim()
            : 'manage-boards request failed',
        };
        if (err?.validation && typeof err.validation === 'object') {
          payload.data = err.validation;
        }
        sendJson(res, statusCode, payload);
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/mcp-extras') {
      const rawBody = await readRawRequestBody(req);
      const body = parseJsonObjectOrEmpty(rawBody);
      requestDetails = {
        routeKind: 'mcp-extras',
        toolName: typeof body?.tool === 'string' ? body.tool.trim() : '',
      };
      requestLogger = processLogger.child(normalizeControlfaceScope('mcp-extras', '', boardRuntimes));
      requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
      res.once('finish', logCompletionOnce);
      res.once('close', logCompletionOnce);
      try {
        await handleMcpExtrasRoute({ rawBody, res, controlfaceMcp });
      } catch (err) {
        const statusCode = Number.isInteger(err?.statusCode) && err.statusCode >= 400 ? err.statusCode : 500;
        sendJson(res, statusCode, {
          error: typeof err?.message === 'string' && err.message.trim()
            ? err.message.trim()
            : 'mcp-extras request failed',
        });
      }
      return;
    }

    try {
      const mcpRouteMatch = req.method === 'POST'
        ? matchLoggedMcpRoute(hostConfig.apiBasePrefix, parsedUrl.pathname)
        : null;
      if (mcpRouteMatch) {
        const boardId = decodeURIComponent(mcpRouteMatch[1] || '').trim();
        const routeKind = normalizeText(mcpRouteMatch[2]);
        const entry = boardRuntimes.get(boardId);
        if (entry) {
          const rawBody = await readRawRequestBody(req);
          const body = parseJsonObjectOrEmpty(rawBody);
          const { strippedBody, logId } = stripLogIdFromMcpBody(body);
          const toolName = typeof strippedBody?.tool === 'string' ? strippedBody.tool.trim() : '';
          const args = normalizeMcpArgs(strippedBody);
          requestDetails = {
            boardId,
            routeKind,
            toolName,
            cardId: normalizeText(readMcpArg(args, 'card_id', 'cardId')),
            turnId: normalizeText(readMcpArg(args, 'turn_id', 'turnId', 'turn')),
          };
          requestLogger = processLogger.child(normalizeControlfaceScope(routeKind, boardId, boardRuntimes));
          requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
          res.once('finish', logCompletionOnce);
          res.once('close', logCompletionOnce);

          emitWatchpartyToolsNotification(entry.runtime, boardId, logId, WATCHPARTY_AGENT_TOOL_ACTIONS.INVOKING, toolName, strippedBody);

          let watchpartyCompletionLogged = false;
          const logWatchpartyCompletionOnce = () => {
            if (watchpartyCompletionLogged) {
              return;
            }
            watchpartyCompletionLogged = true;
            emitWatchpartyToolsNotification(entry.runtime, boardId, logId, WATCHPARTY_AGENT_TOOL_ACTIONS.COMPLETED, toolName, strippedBody);
          };
          res.once('finish', logWatchpartyCompletionOnce);
          res.once('close', logWatchpartyCompletionOnce);

          const replayBody = Buffer.from(JSON.stringify(strippedBody), 'utf8');
          const replayReq = createReplayableRequest(req, replayBody);
          if (replayReq.headers && typeof replayReq.headers === 'object') {
            replayReq.headers = { ...replayReq.headers, 'content-length': String(replayBody.length) };
          }
          if (await entry.runtime.handleRuntimeApi(replayReq, res, parsedUrl)) {
            return;
          }
        }
      }

      if (!requestDetails) {
        const boardMatch = matchBoardRoute(hostConfig.apiBasePrefix, parsedUrl.pathname);
        requestDetails = boardMatch
          ? { boardId: decodeURIComponent(boardMatch[1] || '').trim() }
          : {};
        requestLogger = processLogger.child(normalizeControlfaceScope('', requestDetails.boardId, boardRuntimes));
        requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
        res.once('finish', logCompletionOnce);
        res.once('close', logCompletionOnce);
      }

      for (const [boardId, entry] of boardRuntimes.entries()) {
        if (await entry.runtime.handleRuntimeApi(req, res, parsedUrl)) {
          if (isBoardSseConnectRequest(req, parsedUrl, boardId, hostConfig.apiBasePrefix)) {
            fireAndForgetProcessAccumulated(entry, hostConfig, boardId, requestLogger);
          }
          return;
        }
      }
      sendJson(res, 404, {
        error: 'not found',
        path: parsedUrl.pathname,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!requestDetails) {
        requestDetails = {};
        requestLogger.info(formatControlfacePickupMessage(req, parsedUrl, requestDetails));
        res.once('finish', logCompletionOnce);
        res.once('close', logCompletionOnce);
      }
      requestDetails.errorMessage = message;
      sendJson(res, 500, { error: message });
    }
  });

  server.listen(hostConfig.port, hostConfig.host, () => {
    processLogger.info(`Listening on http://${hostConfig.host}:${hostConfig.port}`);
    void bootstrapConfiguredBoards({ dynamicBoards, hostConfig, adapterServices, boardRuntimes, processLogger })
      .then(() => {
        processLogger.info(`Boards: ${Array.from(boardRuntimes.keys()).join(', ')}`);
      })
      .catch((error) => {
        processLogger.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
        server.close(() => process.exit(1));
      });
  });
}

main().catch((error) => {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  processLogger.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
