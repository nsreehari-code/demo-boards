#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  createArtifactsStore,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

function readJsonStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseBoolean(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseChatEnvelope(raw) {
  // Chat payload supports either plain text or a JSON envelope.
  // JSON fields: prompt|text|userText|query, probe, chatTimeoutMs|chatCopilotTimeoutMs, chatTimeMs.
  if (!raw) {
    return {
      userText: '',
      probe: false,
      chatHandlerMode: 'copilot',
      chatCopilotTimeoutMs: null,
      chatTimeMs: null,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-an-object');
    }
    const prompt = [parsed.prompt, parsed.text, parsed.userText, parsed.query]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    const probe = parseBoolean(parsed.probe, false);
    const modeFromInput = typeof parsed.chatHandlerMode === 'string' ? parsed.chatHandlerMode.trim().toLowerCase() : '';
    return {
      userText: (typeof prompt === 'string' ? prompt : raw).trim(),
      probe,
      chatHandlerMode: modeFromInput || (probe ? 'probe' : 'copilot'),
      chatCopilotTimeoutMs: parsePositiveInt(parsed.chatTimeoutMs ?? parsed.chatCopilotTimeoutMs, null),
      chatTimeMs: parsePositiveInt(parsed.chatTimeMs, null),
    };
  } catch {
    return {
      userText: raw.trim(),
      probe: false,
      chatHandlerMode: 'copilot',
      chatCopilotTimeoutMs: null,
      chatTimeMs: null,
    };
  }
}

function resolveChatDir(extra) {
  if (typeof extra.chatDir === 'string' && extra.chatDir.trim()) return extra.chatDir;
  if (typeof extra.chatsBlobBasePath === 'string' && typeof extra.chatsKeyPrefix === 'string') {
    const cardPart = String(extra.chatsKeyPrefix).split('/')[0];
    return path.join(extra.chatsBlobBasePath, cardPart);
  }
  return '';
}

function resolveChatStoreContext(extra, chatDir) {
  if (typeof extra.chatsBlobBasePath === 'string' && typeof extra.chatsKeyPrefix === 'string') {
    return {
      chatsRoot: extra.chatsBlobBasePath,
      cardPrefix: String(extra.chatsKeyPrefix).split('/')[0],
    };
  }
  if (chatDir) {
    return {
      chatsRoot: path.dirname(chatDir),
      cardPrefix: path.basename(chatDir),
    };
  }
  return { chatsRoot: '', cardPrefix: '' };
}

function resolveProcessingMarker(extra, chatsRoot, cardPrefix, chatDir) {
  const markerKey = typeof extra.chatProcessingMarkerKey === 'string' ? extra.chatProcessingMarkerKey.trim() : '';
  if (markerKey) {
    return {
      markerKey,
      markerPath: path.join(chatsRoot, markerKey),
    };
  }
  if (chatDir) {
    return {
      markerKey: '',
      markerPath: path.join(chatDir, '.processing'),
    };
  }
  return { markerKey: '', markerPath: '' };
}

function createMarker(chatsRoot, markerKey, markerPath) {
  const body = JSON.stringify({ status: 'processing', updated_at: new Date().toISOString() });
  if (markerKey && chatsRoot) {
    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: chatsRoot }));
    const adapter = createFsBoardPlatformAdapter(baseRef, { suppressSpawn: true });
    const artifacts = createArtifactsStore(adapter.blobStorage(''));
    artifacts.putText(markerKey, body, 'application/json; charset=utf-8');
    return;
  }
  if (markerPath) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, body, 'utf-8');
  }
}

const extra = readJsonStdin();
const chatDir = resolveChatDir(extra);
const { chatsRoot, cardPrefix } = resolveChatStoreContext(extra, chatDir);
const lastChatFile = typeof extra.lastChatFile === 'string' ? extra.lastChatFile : '';
const boardId = typeof extra.boardId === 'string' ? extra.boardId : '';
const cardId = typeof extra.cardId === 'string' ? extra.cardId : '';
const boardSetupRoot = typeof extra.boardSetupRoot === 'string' ? extra.boardSetupRoot : '';
const boardRuntimeDir = typeof extra.boardRuntimeDir === 'string' ? extra.boardRuntimeDir : 'runtime';
const runtimeStatusDir = typeof extra.runtimeStatusDir === 'string' ? extra.runtimeStatusDir : 'runtime-out';
const cardsDir = typeof extra.cardsDir === 'string' ? extra.cardsDir : 'cards';
const projectRoot = typeof extra.projectRoot === 'string' ? extra.projectRoot : '';
const chatFlowRoot = typeof extra.chatFlowRoot === 'string' ? extra.chatFlowRoot : '';
const chatsBlobBasePath = typeof extra.chatsBlobBasePath === 'string' ? extra.chatsBlobBasePath : chatsRoot;
const chatsKeyPrefix = typeof extra.chatsKeyPrefix === 'string' ? extra.chatsKeyPrefix : `${cardPrefix}/chats`;
const serverUrl = typeof extra.serverUrl === 'string' ? extra.serverUrl : '';

if (!chatDir || !lastChatFile || !chatsRoot || !cardPrefix) {
  process.stderr.write('chat-open-turn requires chatDir, lastChatFile, chatsRoot, and cardPrefix\n');
  process.exit(1);
}

const lastChatPath = path.join(chatDir, lastChatFile);
let rawUserText = '';
try {
  rawUserText = fs.readFileSync(lastChatPath, 'utf-8');
} catch {
  process.stderr.write('could not read last chat file\n');
  process.exit(1);
}

const envelope = parseChatEnvelope(rawUserText);
const userText = envelope.userText;
const probe = envelope.probe;
const chatHandlerMode = envelope.chatHandlerMode;
const chatCopilotTimeoutMs = envelope.chatCopilotTimeoutMs
  ?? (Number.isFinite(Number(extra.chatCopilotTimeoutMs)) && Number(extra.chatCopilotTimeoutMs) > 0
    ? Math.floor(Number(extra.chatCopilotTimeoutMs))
    : 300000);
const chatTimeMs = envelope.chatTimeMs;

const { markerKey, markerPath } = resolveProcessingMarker(extra, chatsRoot, cardPrefix, chatDir);
try {
  createMarker(chatsRoot, markerKey, markerPath);
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  boardId,
  cardId,
  boardSetupRoot,
  boardRuntimeDir,
  runtimeStatusDir,
  cardsDir,
  projectRoot,
  chatFlowRoot,
  userText,
  chatsRoot,
  cardPrefix,
  chatDir,
  chatsBlobBasePath,
  chatsKeyPrefix,
  lastChatFile,
  serverUrl,
  probe,
  chatHandlerMode,
  chatCopilotTimeoutMs,
  chatTimeMs,
  chatProcessingMarkerKey: markerKey,
  processingMarkerPath: markerPath,
}));
