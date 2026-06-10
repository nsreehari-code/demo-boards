import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  getSampleTemplateEnvelope,
  listSampleTemplateEntries,
} from '../host-shared/mcp-extras/sample-template-catalog.js';
import {
  deriveCardIdFromLogId,
  resolveBoardAgentToolsLogFilePath,
} from '../../chat-flow/shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, 'agentface.tools.json');

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

export function normalizeMcpArgs(body) {
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

export function stripLogIdFromMcpBody(body) {
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

export function readMcpArg(args, ...keys) {
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

export function emitWatchpartyToolsNotification(runtime, boardId, logId, phase, toolName, body) {
  const sanitizedCardId = deriveCardIdFromLogId(logId);
  if (!sanitizedCardId || !boardId) {
    return;
  }

  const outputPath = resolveBoardAgentToolsLogFilePath(boardId, sanitizedCardId);
  const line = formatWatchpartyToolMessage(phase, toolName, body);

  let text = line;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${line}\n`, 'utf8');
    text = fs.readFileSync(outputPath, 'utf8');
  } catch {
  }

  if (!runtime || typeof runtime.emitNotification !== 'function') {
    return;
  }
  try {
    runtime.emitNotification({
      kind: 'card_watchparty',
      cardId: sanitizedCardId,
      channel: 'agent-tools',
      replace: true,
      payload: { text },
      sentAtMs: Date.now(),
    });
  } catch {
  }
}

function lowercaseKeys(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
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
      headers = { ...headers, ...lowercaseKeys(nextHeaders) };
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
    get bodyBytes() {
      return Buffer.concat(chunks);
    },
    get bodyText() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

export async function invokeBoardRuntimeCapture(entry, hostConfig, boardId, routeKind, body) {
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
  const capture = createCaptureResponse();
  const parsedUrl = new URL(`http://${hostConfig.host}:${hostConfig.port}${routePath}`);
  const handled = await entry.runtime.handleRuntimeApi(replayReq, capture, parsedUrl);
  if (!handled) {
    throw new Error(`board runtime did not handle ${routeKind} for '${boardId}'`);
  }
  return capture;
}

export async function invokeBoardRuntimeJson(entry, hostConfig, boardId, routeKind, body) {
  const capture = await invokeBoardRuntimeCapture(entry, hostConfig, boardId, routeKind, body);
  const payload = capture.bodyText ? JSON.parse(capture.bodyText) : null;
  if ((capture.statusCode || 0) >= 400) {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `board runtime request failed with status ${capture.statusCode || 0}`;
    throw new Error(message);
  }
  return payload;
}

function normalizeManifestPath(manifestPath, hostConfig) {
  if (manifestPath && String(manifestPath).trim()) {
    return path.resolve(String(manifestPath).trim());
  }
  const configured = typeof hostConfig?.agentMcp?.manifestPath === 'string'
    ? hostConfig.agentMcp.manifestPath.trim()
    : '';
  if (configured) {
    return path.resolve(configured);
  }
  return DEFAULT_MANIFEST_PATH;
}

function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const toolByName = new Map();
  for (const tool of tools) {
    if (tool && typeof tool.name === 'string' && tool.name.trim()) {
      toolByName.set(tool.name.trim(), tool);
    }
  }
  return { manifest, tools, toolByName };
}

function resolveRouteKind(tool) {
  const configured = typeof tool?.config?.routeKind === 'string' ? tool.config.routeKind.trim() : '';
  if (configured) return configured;
  const remoteTool = resolveRemoteTool(tool);
  return remoteTool === 'inspect.file-contents' ? 'mcp-raw' : 'mcp';
}

function resolveRemoteTool(tool) {
  const configured = typeof tool?.config?.remoteTool === 'string' && tool.config.remoteTool.trim()
    ? tool.config.remoteTool.trim()
    : '';
  if (configured) return configured;
  const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
  if (name.startsWith('liveboards.')) return name.slice('liveboards.'.length);
  return name;
}

function isBoardScoped(tool) {
  return tool?.config?.boardScoped !== false;
}

function requireBoardId(args) {
  const boardId = typeof args?.board_id === 'string' ? args.board_id.trim() : '';
  if (!boardId) {
    throw new Error('board_id is required — pass the board ID as the board_id argument');
  }
  return boardId;
}

function stripBoardId(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const { board_id, ...rest } = args;
  void board_id;
  return rest;
}

function captureErrorMessage(capture, fallback) {
  const text = typeof capture.bodyText === 'string' ? capture.bodyText.trim() : '';
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      return text;
    }
    return text;
  }
  return fallback;
}

function dispatchExtrasTool(hostConfig, remoteTool, args) {
  if (remoteTool === 'explore.list-sample-templates') {
    return listSampleTemplateEntries(hostConfig);
  }
  if (remoteTool === 'explore.get-sample-template') {
    const key = typeof args?.key === 'string'
      ? args.key.trim()
      : (typeof args?.templateKey === 'string' ? args.templateKey.trim() : '');
    return getSampleTemplateEnvelope(hostConfig, key);
  }
  throw new Error(`unknown mcp-extras tool '${remoteTool}'`);
}

function buildManifestDocument(manifest, tools, { endpoint, serverName, serverVersion, defaultDescription }) {
  return {
    server: {
      name: serverName,
      version: serverVersion,
      description: manifest?.server?.description || defaultDescription,
    },
    endpoint,
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || '',
      routeKind: resolveRouteKind(tool),
      boardScoped: isBoardScoped(tool),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    })),
  };
}

export function createControlfaceMcpSurface({ hostConfig, boardRuntimes, manifestPath } = {}) {
  if (!hostConfig || typeof hostConfig !== 'object') {
    throw new Error('createControlfaceMcpSurface requires hostConfig');
  }
  if (!(boardRuntimes instanceof Map)) {
    throw new Error('createControlfaceMcpSurface requires boardRuntimes Map');
  }

  const resolvedManifestPath = normalizeManifestPath(manifestPath, hostConfig);
  const { manifest, tools, toolByName } = loadManifest(resolvedManifestPath);

  async function executeToolCall(name, args) {
    const tool = toolByName.get(name);
    if (!tool) {
      throw new Error(`unknown tool '${name}'`);
    }

    const remoteTool = resolveRemoteTool(tool);
    const routeKind = resolveRouteKind(tool);
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

    if (routeKind === 'mcp-extras') {
      return {
        kind: 'json',
        routeKind,
        remoteTool,
        payload: dispatchExtrasTool(hostConfig, remoteTool, safeArgs),
      };
    }

    const boardScoped = isBoardScoped(tool);
    const boardId = boardScoped ? requireBoardId(safeArgs) : '';
    const upstreamArgs = stripBoardId(safeArgs);
    const body = { tool: remoteTool, args: upstreamArgs };
    const { strippedBody, logId } = stripLogIdFromMcpBody(body);

    let entry = null;
    if (boardScoped) {
      entry = boardRuntimes.get(boardId);
      if (!entry) {
        throw new Error(`unknown board '${boardId}'`);
      }
    } else {
      entry = boardRuntimes.values().next().value || null;
      if (!entry) {
        throw new Error('no board runtime available to service this tool');
      }
    }

    if (boardScoped && logId) {
      emitWatchpartyToolsNotification(entry.runtime, boardId, logId, 'Invoking', remoteTool, strippedBody);
    }

    const capture = await invokeBoardRuntimeCapture(entry, hostConfig, boardId, routeKind, body);

    if (boardScoped && logId) {
      emitWatchpartyToolsNotification(entry.runtime, boardId, logId, 'Completed', remoteTool, strippedBody);
    }

    if ((capture.statusCode || 0) >= 400) {
      throw new Error(captureErrorMessage(capture, `board runtime request failed with status ${capture.statusCode || 0}`));
    }

    if (routeKind === 'mcp-raw') {
      return {
        kind: 'raw',
        routeKind,
        remoteTool,
        boardId,
        upstreamArgs,
        capture,
      };
    }

    return {
      kind: 'json',
      routeKind,
      remoteTool,
      payload: capture.bodyText.trim() ? JSON.parse(capture.bodyText) : null,
    };
  }

  function executeExtrasHttp(body) {
    const toolName = typeof body?.tool === 'string' ? body.tool.trim() : '';
    const args = body?.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? body.args
      : (body?.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {});
    if (!toolName) {
      throw new Error('tool is required');
    }
    return dispatchExtrasTool(hostConfig, toolName, args);
  }

  function getAgentManifestDocument(options) {
    return buildManifestDocument(manifest, tools, options);
  }

  return {
    manifest,
    tools,
    toolByName,
    manifestPath: resolvedManifestPath,
    toolCount: tools.length,
    resolveRouteKind,
    isBoardScoped,
    executeToolCall,
    executeExtrasHttp,
    getAgentManifestDocument,
  };
}