import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseRef, serializeRef } from 'yaml-flow/board-worker-adapter';
import {
  buildStoredFileIndex,
  enhanceChatMessageWithFileRefs,
} from '../../../scripts/cli/shared_helpers.js';

let CHAT_STORE_CLI = '';
let CARD_STORE_CLI = '';
let BOARD_LIVE_CARDS_CLI = '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const YAML_FLOW_BUNDLED_CLI_DIR = path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));
const MANAGE_AI_GENERATED_ATTACHMENTS_PATH = path.join(__dirname, 'manage-ai-generated-attachments.js');
export const FINAL_RESPONSE_FILE_NAME = '001-response.txt';
const FILE_STAGE_PREFIX = '100-file-';

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
  const { lastUserTurns = null } = options ?? {};
  const command = lastUserTurns === null
    ? { command: 'read-all' }
    : { command: 'read-all', lastUserTurns };
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

export function readEnhancedChatMessages(chatStoreRef, cardStoreRef, cardId, timeoutMs = 30000, options = {}) {
  if (!chatStoreRef || !cardStoreRef || !cardId) {
    return [];
  }

  try {
    const storedCard = readStoredCardOnce(cardStoreRef, cardId, timeoutMs);
    const storedFiles = buildStoredFileIndex(storedCard);
    const messages = readChatMessages(chatStoreRef, cardId, timeoutMs, options);
    return messages.map((message) => enhanceChatMessageWithFileRefs(message, storedFiles));
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

export function appendAssistantReply(chatStoreRef, cardId, replyText, timeoutMs = 30000) {
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [{ command: 'append', role: 'assistant', text: replyText, files: [] }],
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

export function appendSystemMessage(chatStoreRef, cardId, messageText, timeoutMs = 30000) {
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [{ command: 'append', role: 'system', text: messageText, files: [] }],
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
  finalResponseContainerRef,
  containerDir,
  chatStoreRef = '',
  cardStoreRef = '',
  artifactsStoreRef = '',
}) {
  const stagedFiles = listStagedAttachmentFiles(containerDir);
  if (stagedFiles.length === 0) {
    return null;
  }

  const args = [
    MANAGE_AI_GENERATED_ATTACHMENTS_PATH,
    '--base-ref',
    baseRefValue,
    '--card-id',
    currentCardId,
    '--attachments-container-ref',
    finalResponseContainerRef,
  ];

  if (typeof chatStoreRef === 'string' && chatStoreRef.trim()) {
    args.push('--chat-store-ref', chatStoreRef.trim());
  }
  if (typeof cardStoreRef === 'string' && cardStoreRef.trim()) {
    args.push('--card-store-ref', cardStoreRef.trim());
  }
  if (typeof artifactsStoreRef === 'string' && artifactsStoreRef.trim()) {
    args.push('--artifacts-store-ref', artifactsStoreRef.trim());
  }

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `manage-ai-generated-attachments.js failed with exit code ${result.status}`);
  }

  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export function createFinalResponseContainer(scratchStoreRef, cardId, scopeName = 'assistant-final-response') {
  requireRequiredStrings({ scratchStoreRef, cardId }, 'final response container');
  const scratchDir = resolveStoreDir(scratchStoreRef, 'scratchStoreRef');
  const containerDir = path.join(scratchDir, scopeName, cardId, randomUUID());
  fs.mkdirSync(containerDir, { recursive: true });
  return {
    containerDir,
    containerRef: createFsPathRef(containerDir, 'finalResponseContainerDir'),
    responseFilePath: path.join(containerDir, FINAL_RESPONSE_FILE_NAME),
  };
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
  finalResponseContainerRef = '',
  containerDir = '',
  replyText = '',
  timeoutMs = 30000,
} = {}) {
  requireRequiredStrings({ chatStoreRef, cardId, finalResponseContainerRef, containerDir, replyText }, 'final response publish');

  const hasStagedAttachments = listStagedAttachmentFiles(containerDir).length > 0;
  const attachmentsResult = hasStagedAttachments
    ? publishStagedAttachments({
      baseRefValue: baseRef,
      currentCardId: cardId,
      finalResponseContainerRef,
      containerDir,
      chatStoreRef,
      cardStoreRef,
      artifactsStoreRef,
    })
    : null;

  appendAssistantReply(chatStoreRef, cardId, replyText, timeoutMs);
  fs.rmSync(containerDir, { recursive: true, force: true });

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

export function readStoredCard(storeRef, cardId, timeoutMs = 30000) {
  if (!storeRef || !cardId) return null;
  try {
    const raw = execFileSync(process.execPath, [
      requireConfiguredCliPath(CARD_STORE_CLI, 'card-store-cli'),
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