import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseRef } from 'yaml-flow/board-worker-adapter';

const require = createRequire(import.meta.url);
const YAML_FLOW_PACKAGE_JSON = require.resolve('yaml-flow/package.json');
const CHAT_STORE_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'chat-store-cli.js');
const CARD_STORE_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'card-store-cli.js');
const BOARD_LIVE_CARDS_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'board-live-cards-cli.js');

function resolveFsPathRef(ref, fieldName) {
  requireNonEmptyString(ref, fieldName);
  const parsedRef = parseRef(ref);
  if (!parsedRef || parsedRef.kind !== 'fs-path' || typeof parsedRef.value !== 'string' || parsedRef.value.trim().length === 0) {
    throw new Error(`Expected ${fieldName} to be an fs-path ref`);
  }
  return parsedRef.value;
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

function runChatStoreCommands(chatStoreRef, cardId, commands, timeoutMs = 30000) {
  const raw = execFileSync(process.execPath, [CHAT_STORE_CLI, '--stdin'], {
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

function runBoardLiveCardsCommand(baseRef, command, extraArgs = [], options = {}) {
  const raw = execFileSync(process.execPath, [
    BOARD_LIVE_CARDS_CLI,
    command,
    '--base-ref',
    baseRef,
    ...extraArgs,
  ], {
    input: options.input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30000,
    windowsHide: true,
  }).trim();

  return raw ? JSON.parse(raw) : null;
}

function writeStoredCards(storeRef, cards, timeoutMs = 30000) {
  const payload = Array.isArray(cards) ? cards : [cards];
  execFileSync(process.execPath, [
    CARD_STORE_CLI,
    'set',
    '--store-ref',
    storeRef,
  ], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function checksumCard(card) {
  return JSON.stringify(card);
}

function normalizeCardFileEntry(cardId, fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
    return fileEntry;
  }

  const normalized = {};
  if (typeof fileEntry.name === 'string' && fileEntry.name.length > 0) {
    normalized.name = fileEntry.name;
  }
  if (typeof fileEntry.stored_name === 'string' && fileEntry.stored_name.length > 0) {
    normalized.stored_name = fileEntry.stored_name;
  }

  const normalizedPath = typeof fileEntry.path === 'string' && fileEntry.path.length > 0
    ? fileEntry.path
    : (typeof fileEntry.stored_name === 'string' && fileEntry.stored_name.length > 0 && typeof cardId === 'string' && cardId.length > 0
      ? `${cardId}/files/${fileEntry.stored_name}`
      : '');
  if (normalizedPath) {
    normalized.path = normalizedPath;
  }

  return normalized;
}

function normalizeStoredCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return card;
  }

  if (!Array.isArray(card.card_data?.files)) {
    return card;
  }

  return {
    ...card,
    card_data: {
      ...(card.card_data && typeof card.card_data === 'object' && !Array.isArray(card.card_data) ? card.card_data : {}),
      files: card.card_data.files.map((fileEntry) => normalizeCardFileEntry(card.id, fileEntry)),
    },
  };
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

function readChatRecordsOnce(chatStoreRef, cardId, timeoutMs = 30000) {
  const parsed = runChatStoreCommands(
    chatStoreRef,
    cardId,
    [{ command: 'read-all' }],
    timeoutMs,
  );
  const records = getBatchCommandData(parsed)?.records;
  return Array.isArray(records) ? records : [];
}

export function readChatMessages(chatStoreRef, cardId, timeoutMs = 30000) {
  if (!chatStoreRef || !cardId) {
    return [];
  }

  try {
    const records = readChatRecordsOnce(chatStoreRef, cardId, timeoutMs);
    if (records.length > 0) {
      return records;
    }

    const waitBudgetMs = Math.min(timeoutMs, 2000);
    const deadline = Date.now() + waitBudgetMs;
    while (Date.now() < deadline) {
      sleepMs(100);
      const retriedRecords = readChatRecordsOnce(chatStoreRef, cardId, timeoutMs);
      if (retriedRecords.length > 0) {
        return retriedRecords;
      }
    }

    return records;
  } catch {
    return [];
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

export function resolveStoreDir(storeRef, fieldName) {
  return resolveFsPathRef(storeRef, fieldName);
}

export function readStoredCard(storeRef, cardId, timeoutMs = 30000) {
  if (!storeRef || !cardId) return null;
  try {
    const raw = execFileSync(process.execPath, [
      CARD_STORE_CLI,
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

export function readAllStoredCards(storeRef, timeoutMs = 30000) {
  if (!storeRef) return [];
  try {
    const raw = execFileSync(process.execPath, [
      CARD_STORE_CLI,
      'get',
      '--store-ref',
      storeRef,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((card) => card && typeof card === 'object') : [];
  } catch {
    return [];
  }
}

export function createCardStoreSnapshot(baseRef, storeRef) {
  if (!baseRef || !storeRef) {
    return null;
  }

  const cards = readAllStoredCards(storeRef).map((card) => normalizeStoredCard(card));
  return {
    storeRef,
    baseRef,
    cardsById: new Map(
      cards
        .filter((card) => typeof card.id === 'string' && card.id.length > 0)
        .map((card) => [card.id, card])
    ),
    checksumIndex: new Map(
      cards
        .filter((card) => typeof card.id === 'string' && card.id.length > 0)
        .map((card) => [card.id, checksumCard(card)])
    ),
  };
}

export function syncChangedCardsToBoard(snapshot) {
  if (!snapshot) {
    return;
  }

  const currentCardsById = new Map(
    readAllStoredCards(snapshot.storeRef)
      .map((card) => normalizeStoredCard(card))
      .filter((card) => typeof card?.id === 'string' && card.id.length > 0)
      .map((card) => [card.id, card])
  );
  const changedCardIds = new Set();
  for (const [cardId, currentCard] of currentCardsById.entries()) {
    if (snapshot.checksumIndex.get(cardId) !== checksumCard(currentCard)) {
      changedCardIds.add(cardId);
    }
  }
  for (const cardId of snapshot.checksumIndex.keys()) {
    if (!currentCardsById.has(cardId)) {
      changedCardIds.add(cardId);
    }
  }

  for (const changedCardId of changedCardIds) {
    if (!changedCardId) {
      continue;
    }

    const currentCard = currentCardsById.get(changedCardId) ?? null;
    if (currentCard) {
      const refreshResult = runBoardLiveCardsCommand(
        snapshot.baseRef,
        'upsert-card',
        ['--card-id', changedCardId, '--restart'],
      );

      if (refreshResult?.status !== 'success') {
        throw new Error(refreshResult?.error ?? `Failed to refresh changed card "${changedCardId}"`);
      }
      continue;
    }

    if (!snapshot.cardsById.has(changedCardId)) {
      continue;
    }

    const removeResult = runBoardLiveCardsCommand(
      snapshot.baseRef,
      'remove-card',
      ['--id', changedCardId],
    );
    if (removeResult?.status !== 'success') {
      throw new Error(removeResult?.error ?? `Failed to remove deleted card "${changedCardId}" from board runtime`);
    }
  }
}

export function validateAllCards(baseRef, storeRef, timeoutMs = 30000) {
  if (!baseRef || !storeRef) {
    return {};
  }

  const cards = readAllStoredCards(storeRef, timeoutMs);
  if (cards.length === 0) {
    return {};
  }

  const issuesByCardId = {};
  for (const card of cards) {
    const currentCardId = typeof card.id === 'string' ? card.id : '';
    if (!currentCardId) {
      issuesByCardId['(unknown)'] = ['Card from card-store-cli is missing a string id'];
      continue;
    }

    const normalizedCard = normalizeStoredCard(card);
    if (checksumCard(normalizedCard) !== checksumCard(card)) {
      writeStoredCards(storeRef, normalizedCard, timeoutMs);
    }

    const validation = runBoardLiveCardsCommand(
      baseRef,
      'validate-card-preflight',
      [],
      {
        input: JSON.stringify(normalizedCard),
        timeoutMs,
      },
    );

    if (validation?.status !== 'success') {
      issuesByCardId[currentCardId] = [validation?.error ?? 'validate-card-preflight failed'];
      continue;
    }

    const result = validation.data && typeof validation.data === 'object'
      ? validation.data
      : null;
    if (!result) {
      issuesByCardId[currentCardId] = ['validateCardPreflight returned no result for card'];
      continue;
    }

    if (!result.isValid) {
      const failedCardId = result.cardId || currentCardId;
      const issues = Array.isArray(result.issues) ? result.issues : ['Unknown validation failure'];
      if (issues.length > 0) {
        issuesByCardId[failedCardId] = issues;
      }
    }
  }

  return issuesByCardId;
}

export function hasValidationIssues(issuesByCardId) {
  return Object.keys(issuesByCardId).length > 0;
}