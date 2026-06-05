#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
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
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../host-shared/logging.js';
import { deriveCardIdFromLogId, resolveBoardAgentToolsLogFilePath } from '../../chat-flow/shared.js';
import {
  createHostedImmediateTaskExecutorRef,
  loadTaskExecutorModule,
} from '../host-shared/worker-modules/task-executor-module.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'hosted-board-runtime.config.json');
const SETUP_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-single-ai-workspace.js');

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
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions') {
    return joinParts([method, routeLabel, normalizeText(details.toolName), normalizeText(details.cardId), normalizeText(details.turnId)]);
  }
  return joinParts([method, routeLabel]);
}

function formatControlfaceCompletionMessage(req, parsedUrl, details = {}, statusCode = 0) {
  const method = normalizeText(req?.method) || 'GET';
  const status = String(statusCode || 0);
  const routeLabel = resolveControlfaceRouteLabel(parsedUrl, details);
  if (details.routeKind === 'mcp' || details.routeKind === 'mcp-controlplane' || details.routeKind === 'mcp-actions') {
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
      parts.push(phraseForFileName(readMcpArg(args, 'file_name', 'fileName')));
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
    return;
  }

  const outputPath = resolveBoardAgentToolsLogFilePath(boardId, sanitizedCardId);
  const line = formatWatchpartyToolMessage(phase, toolName, body);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${line}\n`, 'utf8');
  } catch {
    // Watchparty tool logging must never block request handling.
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
  const runtime = createSingleBoardServerRuntime({
    apiBasePath: `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`,
    boardId,
    boards: [{
      ...bundle.boardContextConfig,
    }],
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
  });
  return { runtime, boardRuntimeNeeds };
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

function runSetupSingleAiWorkspaceScript(boardId, configPath) {
  return new Promise((resolve, reject) => {
    const args = [SETUP_SCRIPT_PATH, boardId];
    if (configPath) {
      args.push('--config', configPath);
    }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`setup-single-ai-workspace.js exited with code ${code}: ${stderr || stdout}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function summarizeBoardForList(board) {
  return {
    id: board.id,
    label: board.label,
    ai: board.ai,
    aiWorkspaceTemplate: board.aiWorkspaceTemplate,
    metadata: board.metadata,
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
    await runSetupSingleAiWorkspaceScript(id, hostConfig.configPath);
    const runtimePair = await buildSingleBoardRuntime(hostConfig, adapterServices, board, processLogger);
    boardRuntimes.set(id, runtimePair);
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
    await runSetupSingleAiWorkspaceScript(id, hostConfig.configPath);
    const runtimePair = await buildSingleBoardRuntime(hostConfig, adapterServices, board, processLogger);
    boardRuntimes.set(id, runtimePair);
    sendJson(res, 200, { status: 'success', data: { board: summarizeBoardForList(board) } });
    return;
  }

  sendJson(res, 400, { status: 'error', error: `unknown subcommand '${subcommand}'` });
}

async function main() {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH, process.argv.slice(2), 'controlface');
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  await dynamicBoards.ensureSeeded();
  const boardRuntimes = await buildBoardRuntimes(hostConfig, adapterServices, dynamicBoards);

  const server = http.createServer(async (req, res) => {
    let requestDetails = null;
    let requestLogger = processLogger.child('controlface:api');
    const parsedBaseUrl = new URL(req.url || '/', `http://${hostConfig.host}:${hostConfig.port}`);
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
      await handleManageBoardsRoute({
        req,
        res,
        dynamicBoards,
        hostConfig,
        adapterServices,
        boardRuntimes,
        processLogger,
      });
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

          appendWatchpartyToolsLog(boardId, logId, 'Invoking', toolName, strippedBody);

          let watchpartyCompletionLogged = false;
          const logWatchpartyCompletionOnce = () => {
            if (watchpartyCompletionLogged) {
              return;
            }
            watchpartyCompletionLogged = true;
            appendWatchpartyToolsLog(boardId, logId, 'Completed', toolName, strippedBody);
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

      for (const { runtime } of boardRuntimes.values()) {
        if (await runtime.handleRuntimeApi(req, res, parsedUrl)) {
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
    processLogger.info(`Boards: ${Array.from(boardRuntimes.keys()).join(', ')}`);
  });
}

main().catch((error) => {
  const processLogger = createLogger('controlface', { filePath: HOSTED_SERVER_LOG_PATH });
  processLogger.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
