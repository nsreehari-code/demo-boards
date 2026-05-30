import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseRef, serializeRef } from 'yaml-flow/board-worker-adapter';
import { publishStagedAttachments as publishManagedAiGeneratedAttachments } from './manage-ai-generated-attachments.js';

let CHAT_STORE_CLI = '';
let CARD_STORE_CLI = '';
let BOARD_LIVE_CARDS_CLI = '';
const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:7801/mcp';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_CONFIG_PATH = path.join(BOARD_ROOT, 'server-config.json');
const require = createRequire(import.meta.url);
const YAML_FLOW_BUNDLED_CLI_DIR = path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));
export const FINAL_RESPONSE_FILE_NAME = '001-response.txt';
const FILE_STAGE_PREFIX = '100-file-';

function loadServerConfig() {
  if (!fs.existsSync(SERVER_CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(SERVER_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const serverConfig = loadServerConfig();

export function resolveAssistantDebugEnabled() {
  return serverConfig?.ENABLE_ASSISTANT_DEBUG === true;
}

export function resolveAssistantDebugFile() {
  const value = typeof serverConfig?.DEBUG_ASSISTANT_FILE === 'string'
    ? serverConfig.DEBUG_ASSISTANT_FILE.trim()
    : '';
  return value;
}

function resolveLiveboardsMcpServerUrl() {
  const envOverride = typeof process.env.DEMO_BOARDS_MCP_SERVER_URL === 'string'
    ? process.env.DEMO_BOARDS_MCP_SERVER_URL.trim()
    : '';
  const configuredUrl = typeof serverConfig?.mcpServerUrl === 'string'
    ? serverConfig.mcpServerUrl.trim()
    : '';
  return envOverride || configuredUrl || DEFAULT_MCP_SERVER_URL;
}

function resolveFsPathRef(ref, fieldName) {
  requireNonEmptyString(ref, fieldName);
  const parsedRef = parseRef(ref);
  if (!parsedRef || parsedRef.kind !== 'fs-path' || typeof parsedRef.value !== 'string' || parsedRef.value.trim().length === 0) {
    throw new Error(`Expected ${fieldName} to be an fs-path ref`);
  }
  return parsedRef.value;
}

export function createFsPathRef(dirPath, fieldName = 'path') {
  requireNonEmptyString(dirPath, fieldName);
  const normalizedPath = dirPath.trim();
  if (!path.isAbsolute(normalizedPath)) {
    throw new Error(`Expected ${fieldName} to be an absolute path`);
  }
  return serializeRef({ kind: 'fs-path', value: normalizedPath });
}

export function readJsonStdin() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function requireNonEmptyString(value, fieldName, contextLabel = 'handler') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required ${contextLabel} input: ${fieldName}`);
  }
}

export function requireRequiredStrings(fields, contextLabel = 'handler') {
  for (const [fieldName, value] of Object.entries(fields)) {
    requireNonEmptyString(value, fieldName, contextLabel);
  }
}

function appendRequiredLogId(args, logId, contextLabel) {
  requireNonEmptyString(logId, 'logId', contextLabel);
  return {
    ...args,
    log_id: logId.trim(),
  };
}

export async function callLiveboardsTool(toolName, args = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(resolveLiveboardsMcpServerUrl()));
  const client = new Client({ name: 'demo-board-chat-flow', version: '0.1.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result?.isError) {
      const errorText = Array.isArray(result?.content)
        ? result.content.map((entry) => (typeof entry?.text === 'string' ? entry.text : '')).join('')
        : '';
      throw new Error(errorText || `${toolName} failed`);
    }

    if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
      return result.structuredContent;
    }

    const text = Array.isArray(result?.content)
      ? result.content.map((entry) => (typeof entry?.text === 'string' ? entry.text : '')).join('')
      : '';
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

export async function readChatMessagesViaMcp(boardId, cardId, options = {}) {
  requireRequiredStrings({ boardId, cardId }, 'liveboards chat read');
  const args = appendRequiredLogId({
    board_id: boardId,
    card_id: cardId,
    ...(options?.tailTurns !== undefined && options?.tailTurns !== null ? { 'tail-turns': options.tailTurns } : {}),
    ...(options?.tail !== undefined && options?.tail !== null ? { tail: options.tail } : {}),
    ...(typeof options?.turnId === 'string' && options.turnId.trim() ? { 'turn-id': options.turnId.trim() } : {}),
    ...(options?.allTurns === true ? { 'all-turns': true } : {}),
    ...(typeof options?.tailTurnsBeforeId === 'string' && options.tailTurnsBeforeId.trim()
      ? { 'tail-turns-before-id': options.tailTurnsBeforeId.trim() }
      : {}),
  }, options?.logId, 'liveboards chat read');
  const result = await callLiveboardsTool('liveboards.inspect.chat-messages-on-cards', args);
  if (result?.status !== 'success') {
    throw new Error(`liveboards.inspect.chat-messages-on-cards returned unexpected payload: ${JSON.stringify(result)}`);
  }
  return Array.isArray(result?.data?.messages) ? result.data.messages : [];
}

export async function readAttachmentTextViaMcp(boardId, cardId, fileIndex, options = {}) {
  requireRequiredStrings({ boardId, cardId }, 'liveboards attachment read');
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    throw new Error('liveboards attachment read requires a non-negative file index');
  }

  const result = await callLiveboardsTool('liveboards.inspect.file-contents', appendRequiredLogId({
    board_id: boardId,
    card_id: cardId,
    file_idx: fileIndex,
  }, options?.logId, 'liveboards attachment read'));
  const resource = Array.isArray(result)
    ? result.find((entry) => entry?.type === 'resource' && typeof entry?.resource?.blob === 'string')
    : null;
  if (!resource?.resource?.blob) {
    return '';
  }

  try {
    return Buffer.from(resource.resource.blob, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

export async function stageAssistantReplyViaMcp(boardId, cardId, turnId, text, files = [], options = {}) {
  requireRequiredStrings({ boardId, cardId, turnId }, 'liveboards assistant reply stage');
  const result = await callLiveboardsTool('liveboards.stage-ai-response-and-any-attachments', appendRequiredLogId({
    board_id: boardId,
    card_id: cardId,
    'turn-id': turnId,
    text,
    files: Array.isArray(files) ? files : [],
  }, options?.logId, 'liveboards assistant reply stage'));
  if (result?.status !== 'success') {
    throw new Error(`liveboards.stage-ai-response-and-any-attachments returned unexpected payload: ${JSON.stringify(result)}`);
  }
  return result.data;
}

function requireConfiguredCliPath(cliPath, cliLabel) {
  if (typeof cliPath !== 'string' || cliPath.trim().length === 0) {
    throw new Error(`${cliLabel} is not configured`);
  }

  return cliPath;
}

export function configureWorkspaceCliScripts(copilotWorkingDir, contextLabel = 'handler') {
  requireNonEmptyString(copilotWorkingDir, 'copilotWorkingDir', contextLabel);

  const scriptsDir = path.join(copilotWorkingDir, '.github', 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    throw new Error(`Missing required ${contextLabel} input: ${scriptsDir}`);
  }

  CHAT_STORE_CLI = path.join(YAML_FLOW_BUNDLED_CLI_DIR, 'chat-store-cli.mjs');
  CARD_STORE_CLI = path.join(YAML_FLOW_BUNDLED_CLI_DIR, 'card-store-cli.mjs');
  BOARD_LIVE_CARDS_CLI = path.join(YAML_FLOW_BUNDLED_CLI_DIR, 'board-live-cards-cli.mjs');
}

export function resolveCopilotWorkspaceDir(aiWorkspaceRoot, storeRef, cardId, contextLabel = 'handler') {
  requireRequiredStrings({
    aiWorkspaceRoot,
    storeRef,
    cardId,
  }, contextLabel);

  if (!fs.existsSync(aiWorkspaceRoot)) {
    throw new Error(`Missing required ${contextLabel} input: aiWorkspaceRoot directory`);
  }

  const storeDir = resolveStoreDir(storeRef, 'cardStoreRef');
  const cardFilePath = path.join(storeDir, `${cardId}.json`);
  if (!fs.existsSync(cardFilePath)) {
    throw new Error(`Missing required ${contextLabel} input: card file for ${cardId}`);
  }

  const rawCard = fs.readFileSync(cardFilePath, 'utf-8').trim();
  const storedCard = rawCard ? JSON.parse(rawCard) : {};
  const copilotRoot = storedCard?.meta?.ingest === true ? 'gandalf' : 'default';
  const copilotWorkingDir = path.join(aiWorkspaceRoot, copilotRoot);
  if (!fs.existsSync(copilotWorkingDir)) {
    throw new Error(`Missing required ${contextLabel} input: copilot workspace ${copilotRoot}`);
  }

  return copilotWorkingDir;
}

function runChatStoreCommands(chatStoreRef, cardId, commands, timeoutMs = 30000) {
  const raw = execFileSync(process.execPath, [requireConfiguredCliPath(CHAT_STORE_CLI, 'chat-store-cli'), '--stdin'], {
    input: JSON.stringify({
      storeRef: chatStoreRef,
      cardId,
      commands,
    }),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();

  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

function getBatchCommandData(parsed, index = 0) {
  const results = Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(parsed?.data?.results)
      ? parsed.data.results
      : [];
  return results[index]?.data;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readChatRecordsOnce(chatStoreRef, cardId, timeoutMs = 30000, options = {}) {
  const {
    lastUserTurns = null,
    tailTurns = null,
    turnId = '',
    allTurns = false,
    tailTurnsBeforeId = '',
  } = options ?? {};
  const command = {
    command: 'read-all',
    ...(tailTurns === null && lastUserTurns !== null ? { lastUserTurns } : {}),
    ...(tailTurns !== null ? { tailTurns } : {}),
    ...(typeof turnId === 'string' && turnId.trim() ? { turnId: turnId.trim() } : {}),
    ...(allTurns === true ? { allTurns: true } : {}),
    ...(typeof tailTurnsBeforeId === 'string' && tailTurnsBeforeId.trim()
      ? { tailTurnsBeforeId: tailTurnsBeforeId.trim() }
      : {}),
  };
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [command],
    timeoutMs,
  );
  const records = getBatchCommandData(parsed)?.records;
  return Array.isArray(records) ? records : [];
}

function readStoredCardOnce(cardStoreRef, cardId, timeoutMs = 30000) {
  const raw = execFileSync(process.execPath, [requireConfiguredCliPath(CARD_STORE_CLI, 'card-store-cli'), 'get', '--store-ref', cardStoreRef, '--id', cardId], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();

  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
}

function runBoardLiveCardsCommand(args, timeoutMs = 30000) {
  const raw = execFileSync(process.execPath, [requireConfiguredCliPath(BOARD_LIVE_CARDS_CLI, 'board-live-cards-cli'), ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();

  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

function unwrapSuccessfulEnvelope(result, commandName) {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null;
  }

  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }

  throw new Error(`${commandName} returned an unexpected response shape`);
}

function readAttachmentRefs(baseRef, cardId, timeoutMs = 30000) {
  const result = runBoardLiveCardsCommand(['get-attachment-ref', '--base-ref', baseRef, '--card-id', cardId], timeoutMs);
  const data = unwrapSuccessfulEnvelope(result, 'get-attachment-ref');
  const attachments = Array.isArray(data?.attachments) ? data.attachments : [];
  return attachments.filter((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return false;
    }

    return Number.isInteger(attachment.idx)
      && attachment.idx >= 0
      && typeof attachment.ref === 'string'
      && attachment.ref.trim().length > 0;
  });
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

export function readChatMessages(chatStoreRef, cardId, timeoutMs = 30000, options = {}) {
  if (!chatStoreRef || !cardId) {
    return [];
  }

  try {
    const records = readChatRecordsOnce(chatStoreRef, cardId, timeoutMs, options);
    if (records.length > 0) {
      return records;
    }

    const waitBudgetMs = Math.min(timeoutMs, 2000);
    const deadline = Date.now() + waitBudgetMs;
    while (Date.now() < deadline) {
      sleepMs(100);
      const retriedRecords = readChatRecordsOnce(chatStoreRef, cardId, timeoutMs, options);
      if (retriedRecords.length > 0) {
        return retriedRecords;
      }
    }

    return records;
  } catch {
    return [];
  }
}

export function readEnhancedChatMessages(baseRef, chatStoreRef, cardId, timeoutMs = 30000, options = {}) {
  if (!baseRef || !chatStoreRef || !cardId) {
    return [];
  }

  try {
    const attachments = readAttachmentRefs(baseRef, cardId, timeoutMs);
    const messages = readChatMessages(chatStoreRef, cardId, timeoutMs, options);
    return messages.map((message) => enhanceChatMessageWithAttachmentHint(message, cardId, attachments));
  } catch {
    return readChatMessages(chatStoreRef, cardId, timeoutMs, options);
  }
}

export function readLastChatMessage(chatStoreRef, cardId, timeoutMs = 30000) {
  const messages = readChatMessages(chatStoreRef, cardId, timeoutMs);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && typeof message.text === 'string') {
      return message;
    }
  }
  return null;
}

export function appendAssistantReply(chatStoreRef, cardId, replyText, timeoutMs = 30000, turnId = '') {
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [{ command: 'append', role: 'assistant', text: replyText, files: [], ...(turnId ? { turn: turnId } : {}) }],
    timeoutMs,
  );

  if (!parsed) {
    throw new Error('Assistant handler did not receive a response from chat-store-cli');
  }

  const replyId = getBatchCommandData(parsed)?.id;
  if (typeof replyId !== 'string' || replyId.length === 0) {
    throw new Error('Assistant handler did not receive an assistant reply id from chat-store-cli');
  }

  return replyId;
}

export function appendSystemMessage(chatStoreRef, cardId, messageText, timeoutMs = 30000, turnId = '') {
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [{ command: 'append', role: 'system', text: messageText, files: [], ...(turnId ? { turn: turnId } : {}) }],
    timeoutMs,
  );

  if (!parsed) {
    throw new Error('Probe handler did not receive a response from chat-store-cli for system message append');
  }

  const messageId = getBatchCommandData(parsed)?.id;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('Probe handler did not receive a system message id from chat-store-cli');
  }

  return messageId;
}

function sanitizeFileSegment(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const baseName = path.basename(value.trim());
  return baseName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function pickStagedFileName(index, fileEntry) {
  const candidateKeys = ['name', 'fileName', 'filename', 'path', 'stored_name', 'key'];
  let candidateName = '';

  if (fileEntry && typeof fileEntry === 'object' && !Array.isArray(fileEntry)) {
    for (const key of candidateKeys) {
      candidateName = sanitizeFileSegment(fileEntry[key]);
      if (candidateName) {
        break;
      }
    }
  }

  const prefix = `${FILE_STAGE_PREFIX}${String(index + 1).padStart(3, '0')}`;
  return candidateName ? `${prefix}-${candidateName}` : `${prefix}.json`;
}

function readFileEntryContent(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
    return JSON.stringify(fileEntry, null, 2);
  }

  const contentKeys = ['content', 'text', 'body', 'data'];
  for (const key of contentKeys) {
    if (typeof fileEntry[key] === 'string') {
      return fileEntry[key];
    }
  }

  return JSON.stringify(fileEntry, null, 2);
}

function listStagedAttachmentFiles(containerDir) {
  try {
    if (!fs.existsSync(containerDir)) {
      return [];
    }

    return fs.readdirSync(containerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== FINAL_RESPONSE_FILE_NAME)
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function publishStagedAttachments({
  baseRefValue,
  currentCardId,
  containerDir,
  chatStoreRef = '',
  cardStoreRef = '',
  artifactsStoreRef = '',
  turnId = '',
}) {
  const stagedFiles = listStagedAttachmentFiles(containerDir);
  if (stagedFiles.length === 0) {
    return null;
  }

  return publishManagedAiGeneratedAttachments({
    baseRef: baseRefValue,
    cardId: currentCardId,
    attachmentsContainerDir: containerDir,
    chatStoreRef,
    cardStoreRef,
    artifactsStoreRef,
    turnId,
  });
}

export function createFinalResponseContainer(scratchStoreRef, cardId, scopeName = 'assistant-final-response') {
  requireRequiredStrings({ scratchStoreRef, cardId }, 'final response container');
  const scratchDir = resolveStoreDir(scratchStoreRef, 'scratchStoreRef');
  const containerDir = path.join(scratchDir, scopeName, cardId, randomUUID());
  fs.mkdirSync(containerDir, { recursive: true });
  return {
    containerDir,
    responseFilePath: path.join(containerDir, FINAL_RESPONSE_FILE_NAME),
  };
}

export function clearFinalResponseContainer(containerDir) {
  try {
    if (!fs.existsSync(containerDir)) {
      return;
    }
    fs.rmSync(containerDir, { recursive: true, force: true });

    let parentDir = path.dirname(containerDir);
    for (let depth = 0; depth < 2; depth += 1) {
      if (!parentDir || !fs.existsSync(parentDir)) {
        break;
      }
      if (fs.readdirSync(parentDir).length > 0) {
        break;
      }
      fs.rmSync(parentDir, { recursive: true, force: true });
      parentDir = path.dirname(parentDir);
    }
  } catch {}
}

export function stageFinalResponsePayload(containerDir, payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('final response payload must be an object');
  }

  requireNonEmptyString(payload.text, 'text', 'final response payload');
  const files = Array.isArray(payload.files) ? payload.files : [];
  fs.mkdirSync(containerDir, { recursive: true });

  const responseFilePath = path.join(containerDir, FINAL_RESPONSE_FILE_NAME);
  fs.writeFileSync(responseFilePath, payload.text, 'utf8');

  const stagedFiles = files.map((fileEntry, index) => {
    const fileName = pickStagedFileName(index, fileEntry);
    const filePath = path.join(containerDir, fileName);
    fs.writeFileSync(filePath, readFileEntryContent(fileEntry), 'utf8');
    return {
      fileName,
      filePath,
    };
  });

  return {
    responseFilePath,
    stagedFiles,
  };
}

export function readStagedFinalResponse(responseFilePath) {
  try {
    if (!fs.existsSync(responseFilePath)) {
      return '';
    }

    const stagedText = fs.readFileSync(responseFilePath, 'utf-8');
    return stagedText.trim().length > 0 ? stagedText : '';
  } catch {
    return '';
  }
}

export function publishFinalResponseFromContainer({
  baseRef = '',
  chatStoreRef = '',
  cardStoreRef = '',
  artifactsStoreRef = '',
  cardId = '',
  containerDir = '',
  replyText = '',
  timeoutMs = 30000,
  turnId = '',
} = {}) {
  requireRequiredStrings({ chatStoreRef, cardId, containerDir, replyText }, 'final response publish');

  const hasStagedAttachments = listStagedAttachmentFiles(containerDir).length > 0;
  const attachmentsResult = hasStagedAttachments
    ? publishStagedAttachments({
      baseRefValue: baseRef,
      currentCardId: cardId,
      containerDir,
      chatStoreRef,
      cardStoreRef,
      artifactsStoreRef,
      turnId,
    })
    : null;

  appendAssistantReply(chatStoreRef, cardId, replyText, timeoutMs, turnId);
  clearFinalResponseContainer(containerDir);

  return {
    attachmentsResult,
    publishedAttachmentCount: Array.isArray(attachmentsResult?.data?.published)
      ? attachmentsResult.data.published.length
      : 0,
  };
}

export function resolveStoreDir(storeRef, fieldName) {
  return resolveFsPathRef(storeRef, fieldName);
}

function resolveCardStoreCliPath() {
  return CARD_STORE_CLI || path.join(YAML_FLOW_BUNDLED_CLI_DIR, 'card-store-cli.mjs');
}

export function readStoredCard(storeRef, cardId, timeoutMs = 30000) {
  if (!storeRef || !cardId) return null;
  try {
    const raw = execFileSync(process.execPath, [
      resolveCardStoreCliPath(),
      'get',
      '--store-ref',
      storeRef,
      '--id',
      cardId,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : null;
  } catch {
    return null;
  }
}

function cardApiUrl(boardServerPort, boardId, cardId) {
  return `http://127.0.0.1:${boardServerPort}/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`;
}

export async function readCardMetaFieldViaApi({ boardServerPort, boardId, cardId, fieldName }) {
  if (!boardServerPort || !boardId || !cardId || !fieldName) return undefined;
  try {
    const res = await fetch(cardApiUrl(boardServerPort, boardId, cardId), { method: 'GET' });
    if (!res.ok) return undefined;
    const card = await res.json();
    const meta = card && typeof card === 'object' ? card.meta : null;
    if (!meta || typeof meta !== 'object') return undefined;
    return meta[fieldName];
  } catch {
    return undefined;
  }
}

export async function writeCardMetaFieldViaApi({ boardServerPort, boardId, cardId, fieldName, value }) {
  if (!boardServerPort || !boardId || !cardId || !fieldName) return false;
  try {
    const res = await fetch(cardApiUrl(boardServerPort, boardId, cardId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { [fieldName]: value } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}