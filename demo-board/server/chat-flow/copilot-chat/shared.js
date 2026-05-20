import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseRef } from 'yaml-flow/board-worker-adapter';
import { createBoardLiveCardsNonCorePublic } from 'yaml-flow/board-live-cards-public';
import { createCardStore, createCardStorePublic, createFsBoardNonCorePlatformAdapter } from 'yaml-flow/board-live-cards-node';

const require = createRequire(import.meta.url);
const YAML_FLOW_PACKAGE_JSON = require.resolve('yaml-flow/package.json');
const CHAT_STORE_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'chat-store-cli.js');
const CARD_STORE_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'card-store-cli.js');

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

export function createCardStoreSnapshot(setupRoot, storeRef) {
  if (!setupRoot || !storeRef) {
    return null;
  }

  const boardRef = { kind: 'fs-path', value: setupRoot };
  const boardAdapter = createFsBoardNonCorePlatformAdapter(boardRef);
  const kvStorage = boardAdapter.kvStorageForRef(storeRef);
  const cardAdminStore = createCardStore({
    readIndex() {
      const value = kvStorage.read('_index');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    writeIndex(index) {
      kvStorage.write('_index', index);
    },
    readCard(key) {
      const value = kvStorage.read(key);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    writeCard(key, card) {
      kvStorage.write(key, card);
      return JSON.stringify(card);
    },
    cardExists(key) {
      return kvStorage.read(key) !== null;
    },
    defaultCardKey(currentCardId) {
      return currentCardId;
    },
  });
  const cardStorePublic = createCardStorePublic(cardAdminStore);
  const cardsResult = cardStorePublic.get({});
  const cards = cardsResult.status === 'success' && Array.isArray(cardsResult.data?.cards)
    ? cardsResult.data.cards.filter((card) => card && typeof card === 'object')
    : [];

  return {
    boardApi: createBoardLiveCardsNonCorePublic(boardRef, boardAdapter),
    cardAdminStore,
    cardsById: new Map(
      cards
        .filter((card) => typeof card.id === 'string' && card.id.length > 0)
        .map((card) => [card.id, card])
    ),
    checksumIndex: cardAdminStore.readChecksumIndex(),
  };
}

export function syncChangedCardsToBoard(snapshot) {
  if (!snapshot) {
    return;
  }

  const changedCardIds = snapshot.cardAdminStore.changedSince(snapshot.checksumIndex);
  for (const changedCardId of changedCardIds) {
    if (!changedCardId) {
      continue;
    }

    const currentCard = snapshot.cardAdminStore.readCard(changedCardId);
    if (currentCard) {
      const upsertResult = snapshot.boardApi.upsertCard({
        params: { cardId: changedCardId, restart: true },
      });
      if (upsertResult.status !== 'success') {
        throw new Error(upsertResult.error ?? `Failed to refresh changed card "${changedCardId}"`);
      }
      continue;
    }

    if (!snapshot.cardsById.has(changedCardId)) {
      continue;
    }

    const removeResult = snapshot.boardApi.removeCard({
      params: { id: changedCardId },
    });
    if (removeResult.status !== 'success') {
      throw new Error(removeResult.error ?? `Failed to remove deleted card "${changedCardId}" from board runtime`);
    }
  }
}

export function validateAllCards(setupRoot, storeRef, timeoutMs = 30000) {
  if (!setupRoot || !storeRef) {
    return {};
  }

  const cards = readAllStoredCards(storeRef, timeoutMs);
  if (cards.length === 0) {
    return {};
  }

  const boardRef = { kind: 'fs-path', value: setupRoot };
  const boardApi = createBoardLiveCardsNonCorePublic(
    boardRef,
    createFsBoardNonCorePlatformAdapter(boardRef)
  );

  const issuesByCardId = {};
  for (const card of cards) {
    const currentCardId = typeof card.id === 'string' ? card.id : '';
    if (!currentCardId) {
      issuesByCardId['(unknown)'] = ['Card from card-store-cli is missing a string id'];
      continue;
    }

    const validation = boardApi.validateCardPreflight({
      body: card,
    });

    if (validation.status !== 'success') {
      issuesByCardId[currentCardId] = [validation.error ?? 'validateCardPreflight failed'];
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