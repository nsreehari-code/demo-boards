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
import { deriveCardIdFromLogId, resolveBoardAgentToolsLogFilePath } from '../../chat-flow/shared.js';
import {
  createHostedImmediateTaskExecutorRef,
  loadTaskExecutorModule,
} from '../host-shared/worker-modules/task-executor-module.js';
import {
  getSampleTemplateEnvelope,
  listSampleTemplateEntries,
} from '../host-shared/mcp-extras/sample-template-catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'hosted-board-runtime.config.json');
const SETUP_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-single-ai-workspace.js');
const HOSTED_QUEUE_LANE_TUNING = {
  chatAgent: {
    concurrency: 2,
  },
};

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
  return `${resolvedBoardId}:controlface`;
}

function resolveControlfaceRouteLabel(parsedUrl, details = {}) {
  const pathname = normalizeText(parsedUrl?.pathname);
  if (!pathname) {
    return '/';
  }
  const segments = pathname.split('/').filter(Boolean);
  const stem = segments[segments.length - 1] || '';
  return stem ? `/${stem}` : '/';
}

function formatControlfacePickupMessage(req, parsedUrl, details = {}) {
  const method = normalizeText(req?.method) || 'GET';
  const routeLabel = resolveControlfaceRouteLabel(parsedUrl, details);
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions' || details.routeKind === 'mcp-extras') {
    return joinParts([method, routeLabel, normalizeText(details.toolName), normalizeText(details.cardId), normalizeText(details.turnId)]);
  }
  return joinParts([method, routeLabel]);
}

function formatControlfaceCompletionMessage(req, parsedUrl, details = {}, statusCode = 0) {
  const method = normalizeText(req?.method) || 'GET';
  const status = String(statusCode || 0);
  const routeLabel = resolveControlfaceRouteLabel(parsedUrl, details);
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions' || details.routeKind === 'mcp-extras') {
    return joinParts([method, routeLabel, normalizeText(details.toolName), normalizeText(details.cardId), normalizeText(details.turnId), status, normalizeText(details.errorMessage)]);
  }
  return joinParts([method, routeLabel, status, normalizeText(details.errorMessage)]);
}

function titleCase(text) {
  return String(text || '')
    .split(/[._\-\s]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();
}

function resolveMcpToolSemanticName(toolName) {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (!normalized) {
    return 'Unknown MCP Tool';
  }
  return titleCase(normalized) || 'Unknown MCP Tool';
}

function normalizeMcpToolName(toolName) {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (!normalized) return '';
  return normalized.replace(/^liveboards\./, '');
}

function normalizeMcpArgs(body) {
  if (body?.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
    return body.args;
  }
  if (body?.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)) {
    return body.arguments;
  }
  return {};
}

function stripLogIdFromArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { strippedArgs: {}, logId: '' };
  }
  const { log_id, ...rest } = args;
  return {
    strippedArgs: rest,
    logId: typeof log_id === 'string' ? log_id.trim() : '',
  };
}

function stripLogIdFromMcpBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { strippedBody: {}, logId: '' };
  }

  const strippedBody = { ...body };
  let logId = '';

  if (body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
    const stripped = stripLogIdFromArgs(body.args);
    strippedBody.args = stripped.strippedArgs;
    logId = stripped.logId;
  }

  if (body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)) {
    const stripped = stripLogIdFromArgs(body.arguments);
    strippedBody.arguments = stripped.strippedArgs;
    if (!logId) {
      logId = stripped.logId;
    }
  }

  return { strippedBody, logId };
}

function readMcpArg(args, ...keys) {
  for (const key of keys) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return args[key];
    }
  }
  return undefined;
}

function formatChatHistoryScope(args) {
  if (readMcpArg(args, 'all-turns', 'allTurns') === true) {
    return 'across all turns';
  }
  const tailTurns = readMcpArg(args, 'tail-turns', 'tailTurns', 'tail');
  const n = Number.isInteger(tailTurns)
    ? tailTurns
    : Number.parseInt(String(tailTurns ?? ''), 10);
  if (Number.isInteger(n) && n > 0) {
    return `across the last ${n} message${n === 1 ? '' : 's'}`;
  }
  return null;
}

function joinPhrases(parts) {
  const filtered = parts.filter((part) => typeof part === 'string' && part.trim().length > 0);
  if (filtered.length === 0) return '';
  if (filtered.length === 1) return ` ${filtered[0]}`;
  if (filtered.length === 2) return ` ${filtered[0]} and ${filtered[1]}`;
  return ` ${filtered.slice(0, -1).join(', ')} and ${filtered[filtered.length - 1]}`;
}

function phraseForCard(cardId) {
  const text = cardId === undefined || cardId === null ? '' : String(cardId).trim();
  return text ? `for ${text}` : null;
}

function phraseForFileIdx(idx) {
  if (idx === undefined || idx === null || idx === '') return null;
  return `file no. ${idx}`;
}

function phraseForFileName(name) {
  const text = name === undefined || name === null ? '' : String(name).trim();
  return text ? `file '${text}'` : null;
}

function phraseForAttachments(count) {
  if (!Number.isInteger(count) || count <= 0) return 'with no attachments';
  return `with ${count} attachment${count === 1 ? '' : 's'}`;
}

function formatMcpLogDetails(toolName, body) {
  const normalizedToolName = normalizeMcpToolName(toolName);
  const args = normalizeMcpArgs(body);
  const parts = [];
  const cardId = readMcpArg(args, 'card_id', 'cardId');

  switch (normalizedToolName) {
    case 'inspect.board-runtime-status':
    case 'discover.source-kinds':
      break;
    case 'inspect.card-definition-and-runtime':
    case 'manage.read-card':
    case 'manage.upsert-card':
    case 'manage.remove-card':
    case 'provide-final-reply-to-user':
      parts.push(phraseForCard(cardId));
      break;
    case 'inspect.chat-messages-on-cards':
      parts.push(phraseForCard(cardId));
      parts.push(formatChatHistoryScope(args));
      break;
    case 'inspect.file-contents':
      parts.push(phraseForCard(cardId));
      parts.push(phraseForFileIdx(readMcpArg(args, 'file_idx', 'fileIdx')));
      break;
    case 'manage.upload-card-file':
      parts.push(phraseForCard(cardId));
      parts.push(phraseForFileName(readMcpArg(args, 'key', 'templateKey')));
      break;
    case 'stage-ai-response-and-any-attachments': {
      parts.push(phraseForCard(cardId));
      const files = readMcpArg(args, 'files');
      const attachmentCount = Array.isArray(files) ? files.length : 0;
      parts.push(phraseForAttachments(attachmentCount));
      break;
    }
    default:
      if (normalizedToolName.startsWith('preflight.')) {
        parts.push(phraseForCard(cardId));
      }
      break;
  }

  return joinPhrases(parts);
}

function formatWatchpartyToolMessage(phase, toolName, body) {
  const semanticName = resolveMcpToolSemanticName(toolName);
  const details = formatMcpLogDetails(toolName, body);
  return `${phase} '${semanticName}'${details}`;
}

function appendWatchpartyToolsLog(boardId, logId, phase, toolName, body) {
  const sanitizedCardId = deriveCardIdFromLogId(logId);
  if (!sanitizedCardId || !boardId) {
    return null;
  }

  const outputPath = resolveBoardAgentToolsLogFilePath(boardId, sanitizedCardId);
  const line = formatWatchpartyToolMessage(phase, toolName, body);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${line}\n`, 'utf8');
    const text = fs.readFileSync(outputPath, 'utf8');
    return { cardId: sanitizedCardId, channel: 'agent-tools', line, text };
  } catch {
    // Watchparty tool logging must never block request handling.
    return { cardId: sanitizedCardId, channel: 'agent-tools', line, text: line };
  }
}

function emitWatchpartyToolsNotification(runtime, boardId, logId, phase, toolName, body) {
  const appended = appendWatchpartyToolsLog(boardId, logId, phase, toolName, body);
  if (!appended || !runtime || typeof runtime.emitNotification !== 'function') {
    return;
  }
  try {
    runtime.emitNotification({
      kind: 'card_watchparty',
      cardId: appended.cardId,
      channel: appended.channel,
      replace: true,
      payload: { text: appended.text },
      sentAtMs: Date.now(),
    });
  } catch {
    // Watchparty emission must never block request handling.
  }
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

function createReplayableRequest(req, rawBodyBuffer) {
  const replayReq = Readable.from(rawBodyBuffer.length > 0 ? [rawBodyBuffer] : []);
  replayReq.method = req.method;
  replayReq.url = req.url;
  replayReq.headers = req.headers;
  replayReq.httpVersion = req.httpVersion;
  return replayReq;
}

function createCaptureResponse() {
  let statusCode = 200;
  let headers = {};
  const chunks = [];

  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    writeHead(nextStatusCode, nextHeaders = {}) {
      statusCode = nextStatusCode;
      headers = { ...headers, ...nextHeaders };
      return this;
    },
    setHeader(name, value) {
      headers[String(name || '').toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name || '').toLowerCase()];
    },
    write(chunk, encoding) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return true;
    },
    end(chunk, encoding) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return this;
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

async function invokeBoardRuntimeJson(entry, hostConfig, boardId, routeKind, body) {
  const routePath = `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}/${routeKind}`;
  const requestBody = Buffer.from(JSON.stringify(body), 'utf8');
  const replayReq = Readable.from(requestBody.length > 0 ? [requestBody] : []);
  replayReq.method = 'POST';
  replayReq.url = routePath;
  replayReq.headers = {
    'content-type': 'application/json',
    'content-length': String(requestBody.length),
  };
  replayReq.httpVersion = '1.1';
  const captureRes = createCaptureResponse();
  const parsedUrl = new URL(`http://${hostConfig.host}:${hostConfig.port}${routePath}`);
  const handled = await entry.runtime.handleRuntimeApi(replayReq, captureRes, parsedUrl);
  if (!handled) {
    throw new Error(`board runtime did not handle ${routeKind} for '${boardId}'`);
  }
  const payload = captureRes.bodyText ? JSON.parse(captureRes.bodyText) : null;
  if ((captureRes.statusCode || 0) >= 400) {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `board runtime request failed with status ${captureRes.statusCode || 0}`;
    throw new Error(message);
  }
  return payload;
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

  async function closeServer(server, pipePath) {
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
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
      const server = net.createServer((socket) => {
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
        await closeServer(server, pipePath);
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
    queueLaneTuning: HOSTED_QUEUE_LANE_TUNING,
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

function collectTemplatePrivateChatEntries(templatePrivateChat, parentKey = 'chat') {
  if (!isPlainObject(templatePrivateChat)) {
    return [];
  }

  return Object.entries(templatePrivateChat).flatMap(([key, value]) => {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) {
      return [];
    }

    const dottedKey = `${parentKey}.${normalizedKey}`;
    if (!isPlainObject(value)) {
      return [{ key: dottedKey, value }];
    }

    const nestedEntries = collectTemplatePrivateChatEntries(value, dottedKey);
    return nestedEntries.length > 0
      ? [{ key: dottedKey, value }, ...nestedEntries]
      : [{ key: dottedKey, value }];
  });
}

async function applyTemplatePrivateState({ boardEntry, hostConfig, boardId, cardId, card }) {
  const templatePrivateChat = card?.__private?.chat;
  const entries = collectTemplatePrivateChatEntries(templatePrivateChat);
  for (const entry of entries) {
    if (entry.key === 'chat.visible_controlplane_only') {
      continue;
    }

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
    const runtimeEntry = boardRuntimes.get(id);
    let runtimeClosed = false;
    let archived;
    try {
      archived = await dynamicBoards.deprecate(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetryAfterClose = Boolean(runtimeEntry)
        && !runtimeClosed
        && /\bEPERM\b/i.test(message);
      if (canRetryAfterClose) {
        await disposeBoardRuntimeEntry(runtimeEntry, processLogger, id);
        runtimeClosed = true;
        try {
          archived = await dynamicBoards.deprecate(id);
        } catch (retryError) {
          sendJson(res, 400, { status: 'error', error: retryError instanceof Error ? retryError.message : String(retryError) });
          return;
        }
      } else {
        sendJson(res, 400, { status: 'error', error: message });
        return;
      }
    }
    if (!archived) {
      sendJson(res, 404, { status: 'error', error: `board '${id}' not found` });
      return;
    }
    if (runtimeEntry && !runtimeClosed) {
      await disposeBoardRuntimeEntry(runtimeEntry, processLogger, id);
    }
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

async function handleMcpExtrasRoute({ rawBody, res, hostConfig }) {
  const body = parseJsonObjectOrEmpty(rawBody);
  const toolName = typeof body?.tool === 'string' ? body.tool.trim() : '';
  const args = normalizeMcpArgs(body);

  if (!toolName) {
    sendJson(res, 400, { error: 'tool is required' });
    return;
  }

  if (toolName === 'explore.list-sample-templates') {
    sendJson(res, 200, listSampleTemplateEntries(hostConfig));
    return;
  }

  if (toolName === 'explore.get-sample-template') {
    const key = typeof readMcpArg(args, 'key', 'templateKey') === 'string'
      ? readMcpArg(args, 'key', 'templateKey').trim()
      : '';
    sendJson(res, 200, getSampleTemplateEnvelope(hostConfig, key));
    return;
  }

  sendJson(res, 400, { error: `unknown mcp-extras tool '${toolName}'` });
}

async function main() {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH, process.argv.slice(2), 'controlface');
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  const boardRuntimes = await buildBoardRuntimes(hostConfig, adapterServices, dynamicBoards);

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
        await handleMcpExtrasRoute({ rawBody, res, hostConfig });
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

          emitWatchpartyToolsNotification(entry.runtime, boardId, logId, 'Invoking', toolName, strippedBody);

          let watchpartyCompletionLogged = false;
          const logWatchpartyCompletionOnce = () => {
            if (watchpartyCompletionLogged) {
              return;
            }
            watchpartyCompletionLogged = true;
            emitWatchpartyToolsNotification(entry.runtime, boardId, logId, 'Completed', toolName, strippedBody);
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
