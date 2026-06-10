import * as path from 'node:path';
import { deriveBoardRootFromModuleUrl } from '../shared/board-root.js';

const BOARD_ROOT = deriveBoardRootFromModuleUrl(import.meta.url, '..');

function sanitizePathToken(value, fallback = 'unknown') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

export function resolveBoardLogPath(context, filename) {
  const boardId = sanitizePathToken(context?.boardId, 'board');
  const safeFilename = typeof filename === 'string' && filename.trim() ? filename : '';
  return path.join(BOARD_ROOT, 'logs', boardId, safeFilename);
}

function requireNonEmptyString(value, fieldName, contextLabel = 'handler') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required ${contextLabel} input: ${fieldName}`);
  }
}

export function requireRequiredStrings(fields, contextLabel = 'handler') {
  for (const [fieldName, value] of Object.entries(fields)) {
    requireNonEmptyString(value, fieldName, contextLabel);
  }
}

const CONTEXT_FIELDS = ['serverUrl', 'mcpServerUrl', 'agentFaceMcp', 'boardId', 'cardId', 'logId', 'turnId', 'watchPartyDir'];

export const AGENT_OUTPUT_FILE_STEM = 'agent-output.txt';
const AGENT_TOOLS_FILE_STEM = 'agent-tools.txt';

function sanitizeWatchpartyToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

export function deriveLogIdFromCardId(cardId) {
  return `0${sanitizeWatchpartyToken(cardId)}`;
}

export function deriveCardIdFromLogId(logId) {
  const normalized = typeof logId === 'string' ? logId.trim() : '';
  if (!normalized.startsWith('0')) return '';
  const cardToken = normalized.slice(1).trim();
  if (!cardToken) return '';
  return sanitizeWatchpartyToken(cardToken);
}

export function resolveBoardWatchpartyRoot(boardId) {
  return path.join(BOARD_ROOT, 'logs', 'watch-party', sanitizePathToken(boardId, 'board'));
}

export function resolveBoardWatchpartyCardDir(boardId, cardId) {
  return path.join(resolveBoardWatchpartyRoot(boardId), sanitizeWatchpartyToken(cardId));
}

export function resolveBoardAgentToolsLogFilePath(boardId, cardId) {
  return path.join(resolveBoardWatchpartyCardDir(boardId, cardId), AGENT_TOOLS_FILE_STEM);
}

export function buildContext(extra = {}) {
  const ctx = {};
  for (const field of CONTEXT_FIELDS) {
    const raw = extra?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      throw new Error(`buildContext: missing required field "${field}"`);
    }
    ctx[field] = value;
  }
  return Object.freeze(ctx);
}

function normalizePositiveInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

async function importMcpClientModules() {
  const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');

  let streamableModule = null;
  try {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  } catch {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamable-http.js');
  }

  return {
    Client: clientModule.Client,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
  };
}

function normalizeMcpToolResult(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const firstText = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  const structured = response?.structuredContent;

  if (
    structured
    && typeof structured === 'object'
    && !Array.isArray(structured)
    && Object.keys(structured).length === 1
    && Object.prototype.hasOwnProperty.call(structured, 'result')
  ) {
    return structured.result;
  }

  if (firstText && (!structured || (typeof structured === 'object' && Object.keys(structured).length === 0))) {
    try {
      return JSON.parse(firstText.text);
    } catch {
      return firstText.text;
    }
  }

  return structured ?? content ?? response;
}

async function fetchServerTool(serverUrl, tool, args = {}, { controlplane = false } = {}) {
  const normalizedServerUrl = typeof serverUrl === 'string' ? serverUrl.trim().replace(/\/$/, '') : '';
  if (!normalizedServerUrl) {
    throw new Error(`${tool} requires serverUrl`);
  }
  const boardId = typeof args?.board_id === 'string' ? args.board_id.trim() : '';
  if (!boardId) {
    throw new Error(`${tool} requires args.board_id`);
  }
  const suffix = controlplane ? 'mcp-controlplane' : 'mcp';
  const url = `${normalizedServerUrl}/api/boards/${encodeURIComponent(boardId)}/${suffix}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorText = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : `${tool} failed`;
    throw new Error(errorText);
  }
  return payload;
}

export function resolveAgentFaceMcpUrl(context) {
  const serverUrl = typeof context?.serverUrl === 'string' ? context.serverUrl.trim().replace(/\/+$/, '') : '';
  if (!serverUrl) return '';
  const rawPath = typeof context?.agentFaceMcp === 'string' && context.agentFaceMcp.trim()
    ? context.agentFaceMcp.trim()
    : '/agent/mcp';
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${serverUrl}${normalizedPath}`;
}

// liveboards.* tools are served in-process by the controlface agentface endpoint
// (serverUrl + agentFaceMcp). Everything else (lore.*, etc.) stays on mcpServerUrl.
export function resolveMcpUrlForTool(context, toolName) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (name.startsWith('liveboards.')) {
    const agentFaceUrl = resolveAgentFaceMcpUrl(context);
    if (agentFaceUrl) return agentFaceUrl;
  }
  return typeof context?.mcpServerUrl === 'string' ? context.mcpServerUrl.trim() : '';
}

export async function invokeMcpServerTool(context, toolName, args = {}) {
  const normalizedUrl = resolveMcpUrlForTool(context, toolName);
  if (!normalizedUrl) {
    throw new Error(`${toolName} requires context.mcpServerUrl`);
  }
  const { Client, StreamableHTTPClientTransport } = await importMcpClientModules();
  const client = new Client(
    { name: 'demo-board-chat-flow', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(normalizedUrl));

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: toolName,
      arguments: args,
    });
    return {
      status: 'success',
      data: normalizeMcpToolResult(response),
    };
  } catch (error) {
    const errorText = error instanceof Error && typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : `${toolName} failed`;
    throw new Error(errorText);
  } finally {
    if (typeof transport.close === 'function') {
      await transport.close().catch(() => {});
    }
  }
}

async function fetchChatMessagesOnce(serverUrl, boardId, cardId, turnId, tailTurns) {
  const args = { board_id: boardId, card_id: cardId };
  if (typeof turnId === 'string' && turnId.trim()) {
    args.turn_id = turnId.trim();
  }
  const tailTurnsInt = normalizePositiveInt(tailTurns);
  if (tailTurnsInt !== null) {
    args.tail_turns = tailTurnsInt;
  }
  const payload = await fetchServerTool(serverUrl, 'inspect.chat-messages-on-cards', args);
  if (payload?.status !== 'success') {
    throw new Error(`inspect.chat-messages-on-cards returned unexpected payload: ${JSON.stringify(payload)}`);
  }
  return Array.isArray(payload?.data?.messages) ? payload.data.messages : [];
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseSystemMessageFileIndex(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*.*?#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) {
    return null;
  }

  const fileIndex = Number.parseInt(match[2], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return null;
  }

  return fileIndex;
}

function enhanceChatMessageWithAttachmentHint(message, cardId, attachments) {
  const enhanced = {
    ...message,
  };

  const role = typeof message?.role === 'string'
    ? message.role
    : typeof message?.payload?.role === 'string'
      ? message.payload.role
      : '';
  const messageText = typeof message?.text === 'string'
    ? message.text
    : typeof message?.payload?.text === 'string'
      ? message.payload.text
      : '';

  if (role === 'system') {
    const fileIndex = parseSystemMessageFileIndex(messageText);
    const hasAttachment = fileIndex !== null && attachments.some((attachment) => attachment.idx === fileIndex);
    if (hasAttachment) {
      const retrievalHint = `Retrieve using liveboards.inspect.file-contents with current boardId, card_id ${cardId}, file_idx ${fileIndex}`;
      enhanced.retrieval_hint = retrievalHint;
      if (message?.payload && typeof message?.role !== 'string') {
        enhanced.payload = {
          ...message.payload,
          retrieval_hint: retrievalHint,
        };
      }
    }
  }

  return enhanced;
}

async function readChatMessages(serverUrl, boardId, cardId, turnId, tailTurns) {
  if (!boardId || !cardId) {
    return [];
  }

  let lastRecords = [];
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    try {
      const records = await fetchChatMessagesOnce(serverUrl, boardId, cardId, turnId, tailTurns);
      lastRecords = records;
      if (records.length > 0) {
        return records;
      }
    } catch {
      // Chat writes settle asynchronously; tolerate transient inspect failures.
    }
    sleepMs(100);
  }

  return lastRecords;
}

export async function getEnhancedChatMessages(context, { cardId: cardIdOverride, turnId: turnIdOverride, tailTurns = null } = {}) {
  const serverUrl = context?.serverUrl;
  const boardId = context?.boardId;
  const cardId = cardIdOverride !== undefined ? cardIdOverride : context?.cardId;
  const turnId = turnIdOverride !== undefined ? turnIdOverride : context?.turnId;
  if (!boardId || !cardId) {
    return [];
  }

  try {
    const messages = await readChatMessages(serverUrl, boardId, cardId, turnId, tailTurns);
    const attachments = messages
      .map((message) => parseSystemMessageFileIndex(typeof message?.text === 'string' ? message.text : ''))
      .filter((value) => Number.isInteger(value))
      .map((idx) => ({ idx }));
    return messages.map((message) => enhanceChatMessageWithAttachmentHint(message, cardId, attachments));
  } catch {
    return readChatMessages(serverUrl, boardId, cardId, turnId, tailTurns);
  }
}

const VALID_ASSISTANT_KEYS = new Set(['copilot', 'foundry', 'probe']);

function validateAssistantKey(assistantKey) {
  if (!VALID_ASSISTANT_KEYS.has(assistantKey)) {
    throw new Error(`Invalid assistant key: ${assistantKey} (expected one of: copilot, foundry, probe)`);
  }
}

function toCardPrivateKey(assistantKey) {
  validateAssistantKey(assistantKey);
  return `chat.${assistantKey}`;
}

export async function getCardPrivateChatSection(context, assistantKey) {
  const { serverUrl, boardId, cardId } = context ?? {};
  if (!boardId || !cardId) return {};
  try {
    const payload = await fetchServerTool(serverUrl, 'getstate.card-private', {
      board_id: boardId,
      card_id: cardId,
      key: toCardPrivateKey(assistantKey),
    }, { controlplane: true });
    if (payload?.status !== 'success' || payload?.data?.exists !== true) {
      return {};
    }
    const value = payload.data.value;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export async function setCardPrivateChatSection(context, assistantKey, value, { merge = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('setCardPrivate value must be a plain object');
  }
  const { serverUrl, boardId, cardId } = context ?? {};
  if (!boardId || !cardId) return false;
  let nextValue = value;
  if (merge) {
    const existing = await getCardPrivateChatSection(context, assistantKey);
    nextValue = { ...existing, ...value };
  }
  try {
    const payload = await fetchServerTool(serverUrl, 'setstate.card-private', {
      board_id: boardId,
      card_id: cardId,
      key: toCardPrivateKey(assistantKey),
      value: nextValue,
    }, { controlplane: true });
    return payload?.status === 'success';
  } catch {
    return false;
  }
}
