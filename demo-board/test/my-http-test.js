#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createFsQueueStorage, parseRef } from 'yaml-flow/board-live-cards-node';
import { createFirestoreQueueStorage } from 'yaml-flow/firestore-storage';
import { jsonata } from 'yaml-flow/step-machine-public';
import { initializeFirebaseServices } from '../server/hosted-board-runtime/firebase-adapter/firebase-init.js';
import { initializeLocalFsServices } from '../server/hosted-board-runtime/localfs-adapter/localfs-init.js';
import { loadFirebaseHostConfig } from '../server/hosted-board-runtime/firebase-adapter/load-config.js';
import { createDynamicBoards } from '../server/hosted-board-runtime/boards-index/dynamic-boards.js';
import { applyNotification, buildBoardState } from 'yaml-flow/board-state-reducer';
import { runtimeNotificationsFromPayload } from 'yaml-flow/notification-consumer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SSE_WORKER_SCRIPT = path.join(__dirname, 'sse-worker.js');
const cliArgs = process.argv.slice(2);

function readCliOptionValue(args, optionName) {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex === -1) return '';
  return String(args[optionIndex + 1] || '').trim();
}

function parseMode(rawValue) {
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (!normalized || normalized === 'localfs' || normalized === 'local') return 'localfs';
  throw new Error(`Unsupported --mode '${rawValue}'. Only 'localfs' is bundled; re-add the firebase hosted config to enable firebase mode.`);
}

function defaultHostedConfigPathForMode() {
  return path.resolve(__dirname, '../server/hosted-board-runtime/hosted-board-runtime.localfs.config.json');
}

function parseRequestedTests(rawValue) {
  if (!rawValue) return null;
  const requested = new Set(
    rawValue
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  if (requested.size === 0) {
    throw new Error('--run-tests requires at least one test id');
  }
  return requested;
}

function isTestSelected(requestedTests, testId) {
  return !requestedTests || requestedTests.has(String(testId || '').trim().toUpperCase());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function jsonText(value) {
  return JSON.stringify(value);
}

function normalizeRequiredTokens(requires) {
  if (!Array.isArray(requires)) return [];
  return requires.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bindTo = typeof entry.bindTo === 'string'
      ? entry.bindTo.trim()
      : typeof entry.key === 'string'
        ? entry.key.trim()
        : '';
    return bindTo ? [bindTo] : [];
  });
}

function normalizeChatState(chatSnapshot = null) {
  return {
    messages: Array.isArray(chatSnapshot?.messages) ? chatSnapshot.messages : [],
    receiving: chatSnapshot?.receiving === true,
    processing: chatSnapshot?.processing === true,
  };
}

const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);
const PROBE_PROGRESS_LINE = 'Probe progress: staging assistant reply';
const STAGE_AI_RESPONSE_TOOL_LABEL = "Invoking 'Stage Ai Response And Any Attachments'";

function createEmptyHostedSseSnapshot() {
  return {
    boardState: null,
  };
}

function applyHostedSseFrame(prev, payload, latestPayloadRef) {
  const base = prev ?? createEmptyHostedSseSnapshot();
  let boardState = base.boardState;

  if (payload && Array.isArray(payload.cardDefinitions)) {
    boardState = buildBoardState(payload, boardState, selectLiveCardModelFromPayload);
  }

  const notifications = runtimeNotificationsFromPayload(payload);
  if (notifications.length > 0) {
    if (boardState) {
      if (notifications.length > 0) {
        boardState = applyNotification(
          boardState,
          notifications,
          selectLiveCardModelFromPayload,
          () => latestPayloadRef(),
        );
      }
    }
  }

  if (boardState === base.boardState) {
    return base;
  }

  return {
    boardState,
  };
}

function getLatestWatchPartyChannelText(snapshot, cardId, channel) {
  const channelEvents = Array.isArray(snapshot?.boardState?.cardWatchParties?.[cardId]?.[channel])
    ? snapshot.boardState.cardWatchParties[cardId][channel]
    : EMPTY_ARRAY;
  const latestEvent = channelEvents.at(-1) ?? null;
  return String(latestEvent?.payload?.text ?? '');
}

function buildStatusCardIndex(statusSnapshot) {
  const index = new Map();
  for (const entry of (statusSnapshot?.cards ?? [])) {
    const cardId = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (cardId) index.set(cardId, entry);
  }
  return index;
}

function summarizeBoardState(boardState) {
  const summary = {
    card_count: Array.isArray(boardState?.cardIds) ? boardState.cardIds.length : 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
  };
  for (const cardId of (boardState?.cardIds ?? [])) {
    const taskStatus = String(boardState?.modelsById?.[cardId]?.runtime_state?.task_status || '');
    if (taskStatus === 'completed') summary.completed += 1;
    else if (taskStatus === 'failed') summary.failed += 1;
    else if (taskStatus === 'running' || taskStatus === 'in-progress') summary.running += 1;
    else summary.pending += 1;
  }
  return summary;
}

function selectLiveCardModelFromPayload(payload, cardId) {
  const cardDefinitions = Array.isArray(payload?.cardDefinitions) ? payload.cardDefinitions : [];
  const card = cardDefinitions.find((entry) => entry?.id === cardId) ?? { id: cardId, card_data: {} };
  const statusEntry = buildStatusCardIndex(payload?.statusSnapshot).get(cardId) ?? null;
  const runtimeEntry = payload?.cardRuntimeById?.[cardId] ?? null;
  const requires = {};
  for (const token of normalizeRequiredTokens(card?.requires)) {
    requires[token] = Object.prototype.hasOwnProperty.call(payload?.dataObjectsByToken ?? {}, token)
      ? payload.dataObjectsByToken[token]
      : null;
  }
  return {
    id: cardId,
    card,
    card_data: card?.card_data ?? {},
    requires,
    computed_values: runtimeEntry?.computed_values ?? {},
    runtime_state: {
      task_status: statusEntry?.status ?? null,
      card_status: statusEntry?.status ?? null,
      runtime: statusEntry?.runtime ?? runtimeEntry?.runtime ?? {},
      error: statusEntry?.error ?? null,
      blocked_by: Array.isArray(statusEntry?.blocked_by) ? statusEntry.blocked_by : [],
      requires_missing: Array.isArray(statusEntry?.requires_missing) ? statusEntry.requires_missing : [],
    },
    card_chats: payload?.cardChatsByCardId?.[cardId] ? normalizeChatState(payload.cardChatsByCardId[cardId]) : null,
  };
}

function makeTurnId() {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

function httpJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const requestBody = payload == null ? null : JSON.stringify(payload);
    const request = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: requestBody
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody),
            }
          : {},
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let data = responseBody;
          try {
            data = responseBody ? JSON.parse(responseBody) : null;
          } catch {
            data = responseBody;
          }
          resolve({ status: response.statusCode || 0, data });
        });
      },
    );
    request.on('error', reject);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function normalizeSseChunkBuffer(buffer, chunk) {
  return `${buffer}${chunk}`.replace(/\r\n/g, '\n');
}

function parseSseBlocks(buffer) {
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const payloads = [];
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const rawPayload = dataLines.join('\n').trim();
    if (!rawPayload) continue;
    try {
      payloads.push(JSON.parse(rawPayload));
    } catch {
      // Ignore malformed SSE payloads in test helper.
    }
  }
  return { payloads, remainder };
}

function startSseClient(sseUrl, onPayload) {
  const request = http.get(sseUrl, (response) => {
    let buffer = '';
    response.setEncoding('utf-8');
    response.on('data', (chunk) => {
      buffer = normalizeSseChunkBuffer(buffer, chunk);
      const parsed = parseSseBlocks(buffer);
      buffer = parsed.remainder;
      for (const payload of parsed.payloads) {
        onPayload(payload);
      }
    });
  });
  request.on('error', () => {});
  return {
    close() {
      try {
        request.destroy();
      } catch {
        // Ignore best-effort close failures.
      }
    },
  };
}

async function probeHealthz(serverUrl) {
  try {
    const result = await httpJson('GET', `${serverUrl}/healthz`);
    if (result.status !== 200 || result.data?.ok !== true) {
      return { ok: false, result };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectMcpSuccess(result, label) {
  assert(result.status === 200, `${label} returned HTTP ${result.status}: ${jsonText(result.data)}`);
  assert(result.data?.status === 'success', `${label} failed: ${jsonText(result.data)}`);
  return result.data?.data ?? null;
}

function loadCardFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'live-cards', fileName), 'utf-8'));
}

function cloneCardWithId(card, id) {
  const clone = deepCloneJson(card);
  clone.id = id;
  return clone;
}

function readStoredCard(readData) {
  return Array.isArray(readData) ? readData[0] || null : null;
}

function findBoardStatusCard(statusData, cardId) {
  const cards = Array.isArray(statusData?.cards) ? statusData.cards : [];
  return cards.find((card) => (
    String(card?.['card-id'] || '') === cardId
    || String(card?.name || '') === cardId
    || String(card?.id || '') === cardId
  )) || null;
}

function createPollProgress(label) {
  let started = false;
  return {
    tick() {
      if (!started) {
        process.stdout.write(`(waiting for ${label})`);
        started = true;
      }
      process.stdout.write('.');
    },
    done() {
      if (started) {
        process.stdout.write('\n');
      }
    },
  };
}

async function pollBoardStatus(callMcp, attempts, gapMs, predicate, waitLabel = 'board status') {
  let lastStatusData = null;
  const progress = createPollProgress(waitLabel);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    progress.tick();
    const statusData = expectMcpSuccess(
      await callMcp('inspect.board-runtime-status', {}),
      `inspect.board-runtime-status attempt ${attempt}`,
    );
    lastStatusData = statusData;
    if (predicate(statusData)) {
      progress.done();
      return { matched: true, attemptsUsed: attempt, statusData };
    }
    if (attempt < attempts) {
      await sleep(gapMs);
    }
  }
  progress.done();
  return { matched: false, attemptsUsed: attempts, statusData: lastStatusData };
}

function computePortfolioValueViaCardJsonata(card, holdings, priceRows) {
  const computeSteps = Array.isArray(card?.compute) ? card.compute : [];
  const evalContext = {
    requires: {
      holdings_tc1: Array.isArray(holdings) ? holdings : [],
      quotes_tc2: {
        quoteResponse: {
          result: Array.isArray(priceRows) ? priceRows : [],
        },
      },
    },
    computed_values: {},
  };

  for (const step of computeSteps) {
    const bindTo = typeof step?.bindTo === 'string' ? step.bindTo.trim() : '';
    const expr = typeof step?.expr === 'string' ? step.expr : '';
    if (!bindTo || !expr) continue;
    evalContext.computed_values[bindTo] = jsonata(expr).evaluate(evalContext);
  }

  return {
    positions: Array.isArray(evalContext.computed_values.positions) ? evalContext.computed_values.positions : [],
    totalValue: roundMoney(evalContext.computed_values.totalValue),
  };
}

function resolveHostedConfigPath(rawValue) {
  if (!rawValue) return defaultHostedConfigPathForMode(MODE);
  return path.isAbsolute(rawValue) ? rawValue : path.resolve(process.cwd(), rawValue);
}

const MODE = parseMode(readCliOptionValue(cliArgs, '--mode'));

const QUEUE_RUNNER_CONFIG_PATH = resolveHostedConfigPath(readCliOptionValue(cliArgs, '--hosted-config'));
let hostedRuntimeContextPromise = null;

async function getHostedRuntimeContext() {
  if (!hostedRuntimeContextPromise) {
    hostedRuntimeContextPromise = (async () => {
      const hostConfig = loadFirebaseHostConfig(QUEUE_RUNNER_CONFIG_PATH, [], 'queueRunner');
      const adapterServices = hostConfig.storageAdapter === 'localfs'
        ? await initializeLocalFsServices(hostConfig.localfs)
        : await initializeFirebaseServices(hostConfig.firebase);
      const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
      const firebaseServices = hostConfig.storageAdapter === 'firebase' ? adapterServices : null;
      return { hostConfig, firebaseServices, dynamicBoards };
    })();
  }
  return hostedRuntimeContextPromise;
}

async function cleanupHostedRuntimeContext() {
  if (!hostedRuntimeContextPromise) return;
  const pending = hostedRuntimeContextPromise;
  hostedRuntimeContextPromise = null;
  try {
    const context = await pending;
    if (typeof context?.firebaseServices?.app?.delete === 'function') {
      await context.firebaseServices.app.delete();
    }
  } catch {
  }
}

function makeQueueMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getHostedBoardConfig(boardConfigsById, boardId) {
  const boardConfig = boardConfigsById?.[boardId];
  if (!boardConfig) {
    throw new Error(`Hosted config does not define board '${boardId}'`);
  }
  return boardConfig;
}

async function loadBoardConfigsById(dynamicBoards) {
  const list = await dynamicBoards.list();
  const map = {};
  for (const board of list) {
    map[board.id] = board;
  }
  return map;
}

function getLocalFsProcessQueueDir(hostConfig, boardConfigsById, boardId) {
  const boardConfig = getHostedBoardConfig(boardConfigsById, boardId);
  const queueStoreRef = boardConfig?.refs?.queueStoreRef;
  if (!queueStoreRef) {
    throw new Error(`Hosted config for board '${boardId}' is missing queueStoreRef`);
  }
  const parsed = parseRef(queueStoreRef);
  if (parsed.kind !== 'fs-path') {
    throw new Error(`Localfs hosted config for board '${boardId}' must use an fs-path queueStoreRef`);
  }
  return path.join(parsed.value, 'process-accumulated');
}

function getLocalFsTaskExecutorQueueDir(hostConfig, boardConfigsById, boardId) {
  const boardConfig = getHostedBoardConfig(boardConfigsById, boardId);
  const queueStoreRef = boardConfig?.refs?.queueStoreRef;
  if (!queueStoreRef) {
    throw new Error(`Hosted config for board '${boardId}' is missing queueStoreRef`);
  }
  const parsed = parseRef(queueStoreRef);
  if (parsed.kind !== 'fs-path') {
    throw new Error(`Localfs hosted config for board '${boardId}' must use an fs-path queueStoreRef`);
  }
  return path.join(parsed.value, 'task-executor');
}

function getFirebaseProcessQueueCollectionPath(hostConfig, boardConfigsById, boardId) {
  const boardConfig = getHostedBoardConfig(boardConfigsById, boardId);
  const queueStoreRef = boardConfig?.refs?.queueStoreRef;
  if (!queueStoreRef) {
    throw new Error(`Hosted config for board '${boardId}' is missing queueStoreRef`);
  }
  const parsed = parseRef(queueStoreRef);
  if (parsed.kind !== 'firestore') {
    throw new Error(`Firebase hosted config for board '${boardId}' must use a firestore queueStoreRef`);
  }
  return `${parsed.value}-process-accumulated`;
}

function getFirebaseTaskExecutorQueueCollectionPath(hostConfig, boardConfigsById, boardId) {
  const boardConfig = getHostedBoardConfig(boardConfigsById, boardId);
  const queueStoreRef = boardConfig?.refs?.queueStoreRef;
  if (!queueStoreRef) {
    throw new Error(`Hosted config for board '${boardId}' is missing queueStoreRef`);
  }
  const parsed = parseRef(queueStoreRef);
  if (parsed.kind !== 'firestore') {
    throw new Error(`Firebase hosted config for board '${boardId}' must use a firestore queueStoreRef`);
  }
  return `${parsed.value}-task-executor`;
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function findLocalFsActiveQueueFile(queueDir, id) {
  const activeDir = path.join(queueDir, 'active');
  try {
    for (const entry of fs.readdirSync(activeDir)) {
      if (entry.endsWith(`-${id}.json`)) {
        return path.join(activeDir, entry);
      }
    }
  } catch {
  }
  return null;
}

function readLocalFsQueueRecord(queueDir, id) {
  const leasedPath = path.join(queueDir, 'leased', `${id}.json`);
  const deadPath = path.join(queueDir, 'dead', `${id}.json`);
  const donePath = path.join(queueDir, 'done', `${id}.json`);
  const stagedPath = path.join(queueDir, 'staged', `${id}.json`);
  const activePath = findLocalFsActiveQueueFile(queueDir, id);

  if (fs.existsSync(donePath)) return null;
  if (fs.existsSync(deadPath)) {
    const record = readJsonFileSafe(deadPath);
    return record ? { ...record, dead: true } : { id, dead: true };
  }
  if (fs.existsSync(leasedPath)) return readJsonFileSafe(leasedPath);
  if (activePath && fs.existsSync(activePath)) return readJsonFileSafe(activePath);
  if (fs.existsSync(stagedPath)) return readJsonFileSafe(stagedPath);
  return null;
}

async function enqueueProcessAccumulatedWakeup(boardId) {
  const { hostConfig, firebaseServices, dynamicBoards } = await getHostedRuntimeContext();
  const boardConfigsById = await loadBoardConfigsById(dynamicBoards);
  if (hostConfig.storageAdapter === 'localfs') {
    const queueDir = getLocalFsProcessQueueDir(hostConfig, boardConfigsById, boardId);
    const queue = createFsQueueStorage(queueDir);
    const dedupKey = `manual-process-accumulated:${makeQueueMessageId('dedup')}`;
    const message = queue.enqueueIfAbsent
      ? queue.enqueueIfAbsent({ boardRef: `manual:${boardId}` }, dedupKey)
      : queue.enqueue({ boardRef: `manual:${boardId}` });
    if (!message) throw new Error(`Failed to enqueue localfs process-accumulated wakeup for ${boardId}`);
    return { id: message.id };
  }

  const id = makeQueueMessageId('process-accumulated-test');
  const nowIso = new Date().toISOString();
  const queueDoc = {
    id,
    body: { boardRef: `manual:${boardId}` },
    dedupKey: `manual-process-accumulated:${id}`,
    enqueuedAt: nowIso,
    attempt: 0,
    staged: false,
    visibleAfter: nowIso,
    leaseToken: null,
    leaseExpiresAt: null,
    dead: false,
    deadReason: null,
  };
  await firebaseServices.firestore.collection(getFirebaseProcessQueueCollectionPath(hostConfig, boardConfigsById, boardId)).doc(id).set(queueDoc);
  return { id };
}

async function readProcessAccumulatedWakeup(boardId, id) {
  const { hostConfig, firebaseServices, dynamicBoards } = await getHostedRuntimeContext();
  const boardConfigsById = await loadBoardConfigsById(dynamicBoards);
  if (hostConfig.storageAdapter === 'localfs') {
    return readLocalFsQueueRecord(getLocalFsProcessQueueDir(hostConfig, boardConfigsById, boardId), id);
  }
  const snap = await firebaseServices.firestore.collection(getFirebaseProcessQueueCollectionPath(hostConfig, boardConfigsById, boardId)).doc(id).get();
  return snap.exists ? snap.data() ?? null : null;
}

async function enqueueDummyTaskExecutorRequest(boardId) {
  const { hostConfig, firebaseServices, dynamicBoards } = await getHostedRuntimeContext();
  const boardConfigsById = await loadBoardConfigsById(dynamicBoards);
  const marker = makeQueueMessageId('tt-dummy');
  const request = {
    boardId,
    ref: {
      meta: 'task-executor',
      howToRun: 'queue-storage',
      whatToRun: 'tt-dummy',
      extra: { boardId },
    },
    args: {
      subcommand: 'tt-dummy',
      marker,
    },
  };

  if (hostConfig.storageAdapter === 'localfs') {
    const queue = createFsQueueStorage(getLocalFsTaskExecutorQueueDir(hostConfig, boardConfigsById, boardId));
    const message = queue.enqueue(request);
    if (!message) throw new Error(`Failed to enqueue localfs task-executor dummy request for ${boardId}`);
    return { id: message.id, marker };
  }

  const queue = createFirestoreQueueStorage(
    firebaseServices.firestore.collection(getFirebaseTaskExecutorQueueCollectionPath(hostConfig, boardConfigsById, boardId)),
  );
  const message = await queue.enqueue(request);
  return { id: message.id, marker };
}

async function readDummyTaskExecutorRequest(boardId, id) {
  const { hostConfig, firebaseServices, dynamicBoards } = await getHostedRuntimeContext();
  const boardConfigsById = await loadBoardConfigsById(dynamicBoards);
  if (hostConfig.storageAdapter === 'localfs') {
    return readLocalFsQueueRecord(getLocalFsTaskExecutorQueueDir(hostConfig, boardConfigsById, boardId), id);
  }
  const snap = await firebaseServices.firestore.collection(getFirebaseTaskExecutorQueueCollectionPath(hostConfig, boardConfigsById, boardId)).doc(id).get();
  return snap.exists ? snap.data() ?? null : null;
}

const portArg = readCliOptionValue(cliArgs, '--port');
const cliBoardId = readCliOptionValue(cliArgs, '--board-id') || readCliOptionValue(cliArgs, '--board');
const requestedTests = parseRequestedTests(readCliOptionValue(cliArgs, '--run-tests'));

const BOARD_ID = cliBoardId || 'live-test-backend';
const BOARD_SERVER_URL = portArg ? `http://127.0.0.1:${portArg}` : 'http://127.0.0.1:7799';
const API_BASE = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(BOARD_ID)}`;

const PORTFOLIO_CARD_ID = 'card-portfolio-tc1-9008';
const MARKET_PRICES_CARD_ID = 'market-prices-tc2-9027';
const PORTFOLIO_VALUE_CARD_ID = 'portfolio-value-tc3-9043';
const T4_CHAT_CARD_ID = 'card-portfolio-t4-9104';
const T8_CHAT_CARD_ID = 'card-portfolio-t8-9108';
const T9_CHAT_CARD_ID = 'card-portfolio-t9-9109';
const T8F_CHAT_CARD_ID = 'card-portfolio-t8f-9118';
const T9F_CHAT_CARD_ID = 'card-portfolio-t9f-9119';
const TR_PORTFOLIO_CARD_ID = 'card-portfolio-tr-9200';
const TR_MARKET_PRICES_CARD_ID = 'market-prices-tr-9201';
const TR_QUOTES_TOKEN = 'quotes_tr2_9201';
const PROBE_ENVELOPE = '__probe__echo__probe__';
const NON_PROBE_RESPONSE_TIMEOUT_MS = 120_000;

function buildProbeChatText(promptText, assistantStem = '') {
  const normalizedPromptText = String(promptText || '');
  const normalizedAssistantStem = typeof assistantStem === 'string' && assistantStem.trim()
    ? assistantStem.trim()
    : 'echo';
  return `${PROBE_ENVELOPE}${normalizedAssistantStem}__${normalizedPromptText}${PROBE_ENVELOPE}`;
}

const portfolioSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), PORTFOLIO_CARD_ID);
const portfolioT2SeedCard = (() => {
  const clone = deepCloneJson(portfolioSeedCard);
  clone.card_data = clone.card_data && typeof clone.card_data === 'object' ? clone.card_data : {};
  const holdings = Array.isArray(clone.card_data.holdings) ? clone.card_data.holdings : [];
  clone.card_data.holdings = [
    ...holdings,
    {
      ticker: 'AMZN',
      quantity: 4,
      cost_basis: 180,
    },
  ];
  return clone;
})();
const marketPricesSeedCard = cloneCardWithId(loadCardFixture('cardT-market-prices.json'), MARKET_PRICES_CARD_ID);
const portfolioValueSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio-value.json'), PORTFOLIO_VALUE_CARD_ID);
const t4ChatSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), T4_CHAT_CARD_ID);
const t8ChatSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), T8_CHAT_CARD_ID);
const t9ChatSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), T9_CHAT_CARD_ID);
const t8fChatSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), T8F_CHAT_CARD_ID);
const t9fChatSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), T9F_CHAT_CARD_ID);
// TR uses a portfolio card with a unique id that still provides holdings_tc1,
// satisfying the requires of the TR market-prices card (which gets a unique id
// and a unique provides token so it does not collide with other tests).
const trPortfolioSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), TR_PORTFOLIO_CARD_ID);
const trMarketPricesSeedCard = (() => {
  const clone = cloneCardWithId(loadCardFixture('cardT-market-prices.json'), TR_MARKET_PRICES_CARD_ID);
  const provides = Array.isArray(clone.provides) ? clone.provides : [];
  clone.provides = provides.map((entry) => (
    entry && entry.bindTo === 'quotes_tc2'
      ? { ...entry, bindTo: TR_QUOTES_TOKEN }
      : entry
  ));
  return clone;
})();

async function main() {
  const { hostConfig } = await getHostedRuntimeContext();
  const modePrefix = hostConfig.storageAdapter === 'localfs' ? 'L' : 'F';
  const modeLabel = hostConfig.storageAdapter === 'localfs' ? 'localfs' : 'firebase';
  const formatTestId = (testId) => `${modePrefix}-${String(testId || '').trim().toUpperCase()}`;
  const printedTests = requestedTests
    ? Array.from(requestedTests).map((testId) => formatTestId(testId)).join(',')
    : ['MB1', 'TE', 'T0', 'T1', 'TQ', 'TT', 'T2', 'T3', 'T4', 'TS', 'T8', 'T9', 'T8F', 'T9F', 'TR'].map((testId) => formatTestId(testId)).join(',');

  console.log(`\n=== ${modeLabel} controlface MCP smoke test ===`);
  console.log(`target: ${API_BASE}`);
  console.log(`board:  ${BOARD_ID}`);
  console.log(`tests:  ${printedTests}`);

  const healthz = await probeHealthz(BOARD_SERVER_URL);
  if (!healthz.ok) {
    const detail = healthz.error instanceof Error
      ? healthz.error.message
      : jsonText(healthz.result?.data || healthz.result || null);
    console.log(`[setup] skipping: controlface server is not available at ${BOARD_SERVER_URL} (${detail})`);
    return;
  }

  const boards = Array.isArray(healthz.result?.data?.boards) ? healthz.result.data.boards : [];
  console.log(`[setup] healthz ok: boards=${jsonText(boards)}`);

  console.log(`\n=== ${formatTestId('MB1')}: ensure board '${BOARD_ID}' is registered via /manage-boards ===`);
  const manageBoardsUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const listResult = await httpJson('POST', manageBoardsUrl, { subcommand: 'list-boards' });
  assert(
    listResult.status === 200 && listResult.data?.status === 'success',
    `${formatTestId('MB1')} list-boards failed: HTTP ${listResult.status} ${jsonText(listResult.data)}`,
  );
  const initialBoards = Array.isArray(listResult.data?.data?.boards) ? listResult.data.data.boards : [];
  const initialIds = initialBoards.map((board) => String(board?.id || ''));
  console.log(`[${formatTestId('MB1')}] list-boards returned: ${jsonText(initialIds)}`);

  if (!initialIds.includes(BOARD_ID)) {
    console.log(`[${formatTestId('MB1')}] board '${BOARD_ID}' missing; calling add-board`);
    const addResult = await httpJson('POST', manageBoardsUrl, {
      subcommand: 'add-board',
      args: {
        boardId: BOARD_ID,
        record: {
          label: BOARD_ID,
          ai: 'copilot',
          aiWorkspaceTemplate: 'default',
          refsTemplate: 'localfs-default',
          uiTemplate: 'default',
        },
      },
    });
    assert(
      addResult.status === 200 && addResult.data?.status === 'success',
      `${formatTestId('MB1')} add-board failed: HTTP ${addResult.status} ${jsonText(addResult.data)}`,
    );
    const reListResult = await httpJson('POST', manageBoardsUrl, { subcommand: 'list-boards' });
    assert(
      reListResult.status === 200 && reListResult.data?.status === 'success',
      `${formatTestId('MB1')} re-list-boards failed: HTTP ${reListResult.status} ${jsonText(reListResult.data)}`,
    );
    const reListedIds = (Array.isArray(reListResult.data?.data?.boards) ? reListResult.data.data.boards : [])
      .map((board) => String(board?.id || ''));
    assert(
      reListedIds.includes(BOARD_ID),
      `${formatTestId('MB1')} board '${BOARD_ID}' still not listed after add-board: ${jsonText(reListedIds)}`,
    );
    console.log(`[${formatTestId('MB1')}] add-board succeeded; boards now: ${jsonText(reListedIds)}`);
  } else {
    console.log(`[${formatTestId('MB1')}] board '${BOARD_ID}' already registered; reusing existing runtime`);
  }

  const createdCardIds = [];
  const sseState = {
    initialPayload: null,
    latestPayload: null,
    latestStatusData: null,
    statusSummary: null,
    boardState: null,
    boardSnapshot: createEmptyHostedSseSnapshot(),
    chatEvents: [],
    statusHistory: [],
    cardRefreshedEvents: [],
    completedCardIds: new Set(),
  };
  let chatSseWorker = null;
  let chatSseClientId = '';
  const callMcp = (tool, args) => httpJson('POST', `${API_BASE}/mcp`, { tool, args });
  const callControlplaneMcp = (tool, args) => httpJson('POST', `${API_BASE}/mcp-controlplane`, {
    tool,
    args: { board_id: BOARD_ID, ...args },
  });
  const callMcpExtras = (tool, args = {}) => httpJson('POST', `${BOARD_SERVER_URL}/mcp-extras`, {
    tool,
    args,
  });
  const callAction = (tool, cardId, payload = {}) => httpJson('POST', `${API_BASE}/mcp-actions`, {
    tool,
    args: {
      card_id: cardId,
      payload,
    },
  });

  async function readChatMessages(cardId, turnId = '') {
    const payload = expectMcpSuccess(
      await callMcp('inspect.chat-messages-on-cards', {
        card_id: cardId,
        ...(turnId ? { turn_id: turnId } : {}),
      }),
      `inspect.chat-messages-on-cards ${cardId}${turnId ? ` turn ${turnId}` : ''}`,
    );
    return Array.isArray(payload?.messages) ? payload.messages : [];
  }

  async function readChatProcessing(cardId) {
    const payload = expectMcpSuccess(
      await callControlplaneMcp('getstate.is-chat-processing', { card_id: cardId }),
      `getstate.is-chat-processing ${cardId}`,
    );
    return payload?.active === true;
  }

  function captureChatEvents(payload, cardId) {
    if (!payload || payload.kind !== 'notification-batch' || !Array.isArray(payload.notifications)) return;
    for (const notification of payload.notifications) {
      if (!notification || notification.cardId !== cardId) continue;
      if (notification.kind !== 'card_chats' && notification.kind !== 'chat_messages' && notification.kind !== 'chat_processing') {
        continue;
      }
      const messages = Array.isArray(notification.messages) ? notification.messages : [];
      sseState.chatEvents.push({
        at: Date.now(),
        cardId: notification.cardId,
        kind: notification.kind,
        processing: typeof notification.processing === 'boolean'
          ? notification.processing
          : typeof notification.active === 'boolean'
            ? notification.active
            : undefined,
        receiving: typeof notification.receiving === 'boolean' ? notification.receiving : undefined,
        messageCount: messages.length,
        messages,
      });
    }
  }

  function captureCardRefreshedEvents(payload) {
    if (!payload || payload.kind !== 'notification-batch' || !Array.isArray(payload.notifications)) return;
    for (const notification of payload.notifications) {
      if (notification?.kind !== 'card_refreshed') continue;
      sseState.cardRefreshedEvents.push({
        at: Date.now(),
        cardId: String(notification.cardId || ''),
        card: notification.card || null,
      });
    }
  }

  function extractStatusDataFromSsePayload(payload) {
    if (payload?.statusSnapshot && typeof payload.statusSnapshot === 'object') {
      return payload.statusSnapshot;
    }
    if (payload?.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
      for (const notification of payload.notifications) {
        if (notification?.kind === 'status' && notification.status && typeof notification.status === 'object') {
          return notification.status;
        }
      }
    }
    return null;
  }

  function syncProjectedSseState() {
    if (!sseState.boardState) return;
    sseState.statusSummary = summarizeBoardState(sseState.boardState);
    for (const cardId of (sseState.boardState.cardIds ?? [])) {
      const taskStatus = String(sseState.boardState?.modelsById?.[cardId]?.runtime_state?.task_status || '');
      if (taskStatus === 'completed') {
        sseState.completedCardIds.add(cardId);
      }
    }
  }

  function applySseFrame(payload, cardId) {
    sseState.boardSnapshot = applyHostedSseFrame(sseState.boardSnapshot, payload, () => sseState.latestPayload);
    sseState.boardState = sseState.boardSnapshot?.boardState ?? null;

    if (payload && Array.isArray(payload.cardDefinitions)) {
      if (!sseState.initialPayload) {
        sseState.initialPayload = payload;
      }
      sseState.latestPayload = payload;
    }
    if (sseState.boardState) {
      syncProjectedSseState();
    }

    const statusData = extractStatusDataFromSsePayload(payload);
    if (statusData) {
      sseState.latestStatusData = statusData;
      if (!sseState.statusSummary && statusData.summary) {
        sseState.statusSummary = statusData.summary;
      }
      sseState.statusHistory.push({ at: Date.now(), statusData });
      if (sseState.statusHistory.length > 500) {
        sseState.statusHistory.splice(0, sseState.statusHistory.length - 500);
      }
    }

    captureCardRefreshedEvents(payload);
    captureChatEvents(payload, cardId);
  }

  function waitUntil(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
        let result = false;
        try {
          result = predicate();
        } catch {
          result = false;
        }
        if (result) {
          clearInterval(interval);
          resolve(result);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`));
        }
      }, 150);
    });
  }

  function resetBoardSseState({ clearChatEvents = false } = {}) {
    sseState.initialPayload = null;
    sseState.latestPayload = null;
    sseState.latestStatusData = null;
    sseState.statusSummary = null;
    sseState.boardState = null;
    sseState.boardSnapshot = createEmptyHostedSseSnapshot();
    sseState.statusHistory = [];
    sseState.cardRefreshedEvents = [];
    sseState.completedCardIds.clear();
    if (clearChatEvents) {
      sseState.chatEvents = [];
    }
  }

  async function closeBoardSseConnection({ clearChatEvents = false } = {}) {
    if (chatSseWorker) {
      try {
        await chatSseWorker.terminate();
      } catch {
        // Best-effort worker teardown.
      }
      chatSseWorker = null;
    }
    chatSseClientId = '';
    resetBoardSseState({ clearChatEvents });
  }

  async function ensureBoardSseConnection(cardId) {
    if (!chatSseClientId) {
      chatSseClientId = `hosted-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (chatSseWorker && !sseState.initialPayload) {
      try {
        await chatSseWorker.terminate();
      } catch {
        // Best-effort worker teardown before reconnect.
      }
      chatSseWorker = null;
    }
    if (!chatSseWorker) {
      chatSseWorker = new Worker(SSE_WORKER_SCRIPT, {
        workerData: { sseUrl: `${API_BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}` },
      });
      chatSseWorker.on('message', (msg) => {
        if (msg?.type === 'frame') {
          applySseFrame(msg.payload, cardId);
        } else if (msg?.type === 'error') {
          console.error(`[sse-worker] ${msg.message}`);
        }
      });
      chatSseWorker.on('error', (err) => {
        console.error(`[sse-worker] uncaught: ${err.message}`);
      });
      await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `initial /sse payload for ${cardId}`,
      );
    }
  }

  async function ensureChatSseSubscription(cardId) {
    await ensureBoardSseConnection(cardId);
    expectMcpSuccess(
      await callControlplaneMcp('sse.subscribe-chat', {
        card_id: cardId,
        client_id: chatSseClientId,
      }),
      `sse.subscribe-chat ${cardId}`,
    );
  }

  async function unsubscribeChatSseSubscription(cardId) {
    if (!chatSseClientId) {
      return;
    }
    expectMcpSuccess(
      await callControlplaneMcp('sse.unsubscribe-chat', {
        card_id: cardId,
        client_id: chatSseClientId,
      }),
      `sse.unsubscribe-chat ${cardId}`,
    );
  }

  async function subscribeWatchChannel(cardId, channelName) {
    await ensureBoardSseConnection(cardId);
    expectMcpSuccess(
      await callControlplaneMcp('sse.watch-channel', {
        card_id: cardId,
        channel_name: channelName,
        client_id: chatSseClientId,
      }),
      `sse.watch-channel ${cardId} ${channelName}`,
    );
  }

  async function unsubscribeWatchChannel(cardId, channelName) {
    if (!chatSseClientId) {
      return;
    }
    expectMcpSuccess(
      await callControlplaneMcp('sse.unwatch-channel', {
        card_id: cardId,
        channel_name: channelName,
        client_id: chatSseClientId,
      }),
      `sse.unwatch-channel ${cardId} ${channelName}`,
    );
  }

  // Raw chat SSE chronology is intentionally used only by the probe-path
  // transport test (TS). Hosted assistant tests assert converged state instead.
  function collectChatTurnBouquet(events, { turnId }) {
    const orderedMessages = [];
    const seenMessageKeys = new Set();
    let processingOnSeen = false;
    let processingDoneSeen = false;
    for (const event of events) {
      if (event?.processing === true) {
        processingOnSeen = true;
      }
      if (event?.processing === false) {
        processingDoneSeen = true;
      }
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      for (const message of messages) {
        if (turnId && String(message?.turn || '') !== turnId) {
          continue;
        }
        const messageKey = `${message?.role || ''}|${String(message?.text || '')}`;
        if (seenMessageKeys.has(messageKey)) {
          continue;
        }
        seenMessageKeys.add(messageKey);
        orderedMessages.push(message);
      }
    }
    return {
      processingOnSeen,
      processingDoneSeen,
      messages: orderedMessages,
      userMessages: orderedMessages.filter((message) => message?.role === 'user'),
      systemMessages: orderedMessages.filter((message) => message?.role === 'system'),
      assistantMessages: orderedMessages.filter((message) => message?.role === 'assistant'),
    };
  }

  async function waitForChatTurnBouquet({ eventStart, turnId, timeoutMs, label }) {
    return await waitUntil(() => {
      const bouquet = collectChatTurnBouquet(sseState.chatEvents.slice(eventStart), { turnId });
      if (!bouquet.processingDoneSeen) {
        return false;
      }
      return bouquet;
    }, timeoutMs, label);
  }

  async function waitForChatTurnState({ eventStart, turnId, timeoutMs, label, predicate }) {
    return await waitUntil(() => {
      const bouquet = collectChatTurnBouquet(sseState.chatEvents.slice(eventStart), { turnId });
      if (typeof predicate !== 'function') {
        return bouquet.processingDoneSeen ? bouquet : false;
      }
      return predicate(bouquet) ? bouquet : false;
    }, timeoutMs, label);
  }

  async function waitForSseCompletedCard(cardId, timeoutMs, label) {
    return await waitUntil(() => {
      if (sseState.completedCardIds.has(cardId)) {
        return {
          statusData: sseState.latestStatusData ?? { summary: sseState.statusSummary ?? null },
          card: {
            name: cardId,
            status: 'completed',
          },
        };
      }

      const boardTaskStatus = String(sseState.boardState?.modelsById?.[cardId]?.runtime_state?.task_status || '');
      if (boardTaskStatus === 'completed') {
        return {
          statusData: sseState.latestStatusData ?? { summary: sseState.statusSummary ?? null },
          card: {
            name: cardId,
            status: 'completed',
          },
        };
      }

      const snapshots = sseState.statusHistory;
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        const statusData = snapshots[index]?.statusData;
        const card = findBoardStatusCard(statusData, cardId);
        if (card && String(card.status || '') === 'completed') {
          return { statusData, card };
        }
      }
      const latestStatusData = sseState.latestStatusData;
      const latestCard = findBoardStatusCard(latestStatusData, cardId);
      return latestCard && String(latestCard.status || '') === 'completed'
        ? { statusData: latestStatusData, card: latestCard }
        : false;
    }, timeoutMs, label);
  }

  async function waitForSseSummary(timeoutMs, label) {
    return await waitUntil(() => {
      const summary = sseState.statusSummary;
      return summary ? summary : false;
    }, timeoutMs, label);
  }

  async function waitForSseCardRefreshed(cardId, eventStart, timeoutMs, label) {
    return await waitUntil(() => {
      const events = sseState.cardRefreshedEvents.slice(eventStart);
      return events.find((event) => event.cardId === cardId) || false;
    }, timeoutMs, label);
  }

  async function waitForSseCardStatus(cardId, expectedStatus, historyStart, timeoutMs, label) {
    return await waitUntil(() => {
      const snapshots = sseState.statusHistory.slice(historyStart);
      for (const snapshot of snapshots) {
        const card = findBoardStatusCard(snapshot.statusData, cardId);
        if (card && String(card.status || '') === expectedStatus) {
          return { statusData: snapshot.statusData, card };
        }
      }
      return false;
    }, timeoutMs, label);
  }

  async function waitForWatchPartyText({ cardId, channel, timeoutMs, label, predicate }) {
    return await waitUntil(() => {
      const text = getLatestWatchPartyChannelText(sseState.boardSnapshot, cardId, channel);
      if (!text) {
        return false;
      }
      if (typeof predicate === 'function' && !predicate(text)) {
        return false;
      }
      return text;
    }, timeoutMs, label);
  }

  async function pollChatMessages(cardId, turnId, attempts, gapMs, predicate, waitLabel) {
    let lastMessages = [];
    const progress = createPollProgress(waitLabel);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      progress.tick();
      lastMessages = await readChatMessages(cardId, turnId);
      if (predicate(lastMessages)) {
        progress.done();
        return { matched: true, attemptsUsed: attempt, messages: lastMessages };
      }
      if (attempt < attempts) {
        await sleep(gapMs);
      }
    }
    progress.done();
    return { matched: false, attemptsUsed: attempts, messages: lastMessages };
  }

  async function pollChatProcessing(cardId, expectedActive, attempts, gapMs, waitLabel) {
    let lastActive = false;
    const progress = createPollProgress(waitLabel);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      progress.tick();
      lastActive = await readChatProcessing(cardId);
      if (lastActive === expectedActive) {
        progress.done();
        return { matched: true, attemptsUsed: attempt, active: lastActive };
      }
      if (attempt < attempts) {
        await sleep(gapMs);
      }
    }
    progress.done();
    return { matched: false, attemptsUsed: attempts, active: lastActive };
  }

  try {
    if (isTestSelected(requestedTests, 'TE')) {
      console.log(`\n=== ${formatTestId('TE')}: list + get sample templates via /mcp-extras ===`);

      const listed = await callMcpExtras('explore.list-sample-templates');
      assert(listed.status === 200, `TE explore.list-sample-templates returned HTTP ${listed.status}: ${jsonText(listed.data)}`);
      const entries = Array.isArray(listed.data?.entries) ? listed.data.entries : [];
      assert(entries.length > 0, `TE explore.list-sample-templates returned no entries: ${jsonText(listed.data)}`);

      const firstEntry = entries[0] ?? null;
      assert(firstEntry && typeof firstEntry === 'object', `TE first list entry missing: ${jsonText(listed.data)}`);
      assert(typeof firstEntry.key === 'string' && firstEntry.key.trim(), `TE first list entry key missing: ${jsonText(firstEntry)}`);
      assert(typeof firstEntry.label === 'string' && firstEntry.label.trim(), `TE first list entry label missing: ${jsonText(firstEntry)}`);
      assert(!Object.prototype.hasOwnProperty.call(firstEntry, 'fileName'), `TE list entry leaked fileName: ${jsonText(firstEntry)}`);
      console.log(`[${formatTestId('TE')}] list returned ${entries.length} template(s); first key=${firstEntry.key}`);

      const fetched = await callMcpExtras('explore.get-sample-template', { key: firstEntry.key });
      assert(fetched.status === 200, `TE explore.get-sample-template returned HTTP ${fetched.status}: ${jsonText(fetched.data)}`);
      assert(fetched.data && typeof fetched.data === 'object', `TE get-sample-template returned no payload: ${jsonText(fetched.data)}`);
      assert(fetched.data.key === firstEntry.key, `TE get-sample-template key mismatch: ${jsonText(fetched.data)}`);
      assert(typeof fetched.data.label === 'string' && fetched.data.label.trim(), `TE get-sample-template label missing: ${jsonText(fetched.data)}`);
      assert(!Object.prototype.hasOwnProperty.call(fetched.data, 'fileName'), `TE get-sample-template leaked fileName: ${jsonText(fetched.data)}`);
      assert(Array.isArray(fetched.data?.payload?.cards), `TE get-sample-template payload cards missing: ${jsonText(fetched.data)}`);
      console.log(`[${formatTestId('TE')}] get returned template key=${fetched.data.key} cards=${fetched.data.payload.cards.length}`);
    }

    if (isTestSelected(requestedTests, 'T0')) {
      console.log(`\n=== ${formatTestId('T0')}: seed ${PORTFOLIO_CARD_ID} and verify persistence + completed status ===`);

      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioSeedCard,
        }),
        'T0 manage.upsert-card',
      );
      createdCardIds.push(PORTFOLIO_CARD_ID);

      const storedPortfolio = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T0 manage.read-card',
        ),
      );
      assert(!!storedPortfolio, 'T0 manage.read-card returned no card');
      assert(
        jsonText(canonicalizeJson(storedPortfolio)) === jsonText(canonicalizeJson(portfolioSeedCard)),
        `T0 stored card mismatch for ${PORTFOLIO_CARD_ID}`,
      );
      console.log(`[${formatTestId('T0')}] stored card matches seeded card`);

      const t0Poll = await pollBoardStatus(callMcp, 5, 1000, (statusData) => {
        const card = findBoardStatusCard(statusData, PORTFOLIO_CARD_ID);
        return card && String(card.status || '') === 'completed';
      }, `${PORTFOLIO_CARD_ID} to reach completed`);
      assert(
        t0Poll.matched,
        `T0 timed out waiting for ${PORTFOLIO_CARD_ID} to reach completed: ${jsonText(t0Poll.statusData)}`,
      );
      console.log(`[${formatTestId('T0')}] completed in ${t0Poll.attemptsUsed} poll(s)`);
    }

    if (isTestSelected(requestedTests, 'T1')) {
      console.log(`\n=== ${formatTestId('T1')}: discover + preflight tests for ${MARKET_PRICES_CARD_ID} + ${PORTFOLIO_VALUE_CARD_ID} ===`);

      const sourceKinds = expectMcpSuccess(
        await callMcp('discover.source-kinds', {}),
        'T1 discover.source-kinds',
      );
      assert(sourceKinds && typeof sourceKinds === 'object', 'T1 discover.source-kinds returned no payload');
      assert(
        sourceKinds.sourceKinds && typeof sourceKinds.sourceKinds === 'object' && Object.keys(sourceKinds.sourceKinds).length > 0,
        `T1 discover.source-kinds returned no source kinds: ${jsonText(sourceKinds)}`,
      );
      console.log(`[${formatTestId('T1')}] discover.source-kinds ok: ${Object.keys(sourceKinds.sourceKinds).length} kind(s)`);

      const marketPricesPreflight = expectMcpSuccess(
        await callMcp('preflight.validate-candidate-card-definition', {
          candidate_card_content: marketPricesSeedCard,
        }),
        'T1 preflight.validate-candidate-card-definition market-prices',
      );
      assert(marketPricesPreflight?.cardId === MARKET_PRICES_CARD_ID, `T1 market-prices preflight cardId mismatch: ${jsonText(marketPricesPreflight)}`);
      assert(marketPricesPreflight?.isValid === true, `T1 market-prices preflight invalid: ${jsonText(marketPricesPreflight)}`);
      assert(Array.isArray(marketPricesPreflight?.issues), `T1 market-prices preflight issues shape invalid: ${jsonText(marketPricesPreflight)}`);
      console.log(`[${formatTestId('T1')}] market-prices candidate preflight passed`);

      const storedPortfolioForPreflight = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T1 manage.read-card portfolio for source preflight',
        ),
      );
      const holdingsForPreflight = storedPortfolioForPreflight?.card_data?.holdings;
      assert(
        Array.isArray(holdingsForPreflight) && holdingsForPreflight.length > 0,
        'T1 portfolio holdings missing for market-prices source preflight',
      );
      const marketPricesMockProjections = {
        quote_urls: holdingsForPreflight.map((row) => {
          const ticker = String(row?.ticker || '').trim().toUpperCase();
          return `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        }).filter(Boolean),
      };

      const marketPricesProbe = expectMcpSuccess(
        await callMcp('preflight.probe-single-source-in-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          source_idx: 0,
          mock_projections: marketPricesMockProjections,
        }),
        'T1 preflight.probe-single-source-in-candidate-card market-prices',
      );
      assert(marketPricesProbe?.bindTo === 'quotes_tc2', `T1 market-prices source probe bindTo mismatch: ${jsonText(marketPricesProbe)}`);
      assert(typeof marketPricesProbe?.reachable === 'boolean', `T1 market-prices source probe reachable shape invalid: ${jsonText(marketPricesProbe)}`);
      assert(marketPricesProbe?.reachable === true, `T1 market-prices source probe unreachable: ${jsonText(marketPricesProbe)}`);
      if (marketPricesProbe?.latencyMs !== undefined) {
        assert(Number.isFinite(Number(marketPricesProbe.latencyMs)), `T1 market-prices source probe latencyMs shape invalid: ${jsonText(marketPricesProbe)}`);
      }
      console.log(`[${formatTestId('T1')}] market-prices source probe preflight passed`);

      const marketPricesRun = expectMcpSuccess(
        await callMcp('preflight.run-single-source-in-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          source_idx: 0,
          mock_projections: marketPricesMockProjections,
        }),
        'T1 preflight.run-single-source-in-candidate-card market-prices',
      );
      assert(marketPricesRun?.bindTo === 'quotes_tc2', `T1 market-prices source run bindTo mismatch: ${jsonText(marketPricesRun)}`);
      assert(typeof marketPricesRun?.ok === 'boolean', `T1 market-prices source run ok shape invalid: ${jsonText(marketPricesRun)}`);
      assert(Array.isArray(marketPricesRun?.issues), `T1 market-prices source run issues shape invalid: ${jsonText(marketPricesRun)}`);
      assert(marketPricesRun?.ok === true, `T1 market-prices source run failed: ${jsonText(marketPricesRun)}`);
      console.log(`[${formatTestId('T1')}] market-prices source run preflight passed`);

      const marketPricesCycle = expectMcpSuccess(
        await callMcp('preflight.run-one-cycle-with-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          mock_requires: {
            holdings_tc1: holdingsForPreflight,
          },
        }),
        'T1 preflight.run-one-cycle-with-candidate-card market-prices',
      );
      assert(marketPricesCycle?.cardId === MARKET_PRICES_CARD_ID, `T1 market-prices cycle cardId mismatch: ${jsonText(marketPricesCycle)}`);
      assert(typeof marketPricesCycle?.ok === 'boolean', `T1 market-prices cycle ok shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle?.issues), `T1 market-prices cycle issues shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.ok === true, `T1 market-prices cycle failed: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.issues.length === 0, `T1 market-prices cycle issues not empty: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.provides_outputs && typeof marketPricesCycle.provides_outputs === 'object', `T1 market-prices cycle provides_outputs shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.provides_outputs?.quotes_tc2?.quoteResponse?.error === null, `T1 market-prices cycle quotes payload error mismatch: ${jsonText(marketPricesCycle)}`);
      assert(
        Array.isArray(marketPricesCycle?.provides_outputs?.quotes_tc2?.quoteResponse?.result)
        && marketPricesCycle.provides_outputs.quotes_tc2.quoteResponse.result.length > 0,
        `T1 market-prices cycle quotes payload missing results: ${jsonText(marketPricesCycle)}`,
      );
      assert(marketPricesCycle?.rendered_view && typeof marketPricesCycle.rendered_view === 'object', `T1 market-prices cycle rendered_view shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle?.rendered_view?.elements), `T1 market-prices cycle rendered_view elements shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle.rendered_view.elements.length > 0, `T1 market-prices cycle rendered_view elements empty: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle.rendered_view.elements[0]?.resolved), `T1 market-prices cycle rendered_view first resolved shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle.rendered_view.elements[0].resolved.length > 0, `T1 market-prices cycle rendered_view first resolved empty: ${jsonText(marketPricesCycle)}`);
      console.log(`[${formatTestId('T1')}] market-prices simulate-card-cycle preflight passed`);

      const portfolioValuePreflight = expectMcpSuccess(
        await callMcp('preflight.validate-candidate-card-definition', {
          candidate_card_content: portfolioValueSeedCard,
        }),
        'T1 preflight.validate-candidate-card-definition portfolio-value',
      );
      assert(portfolioValuePreflight?.cardId === PORTFOLIO_VALUE_CARD_ID, `T1 portfolio-value preflight cardId mismatch: ${jsonText(portfolioValuePreflight)}`);
      assert(portfolioValuePreflight?.isValid === true, `T1 portfolio-value preflight invalid: ${jsonText(portfolioValuePreflight)}`);
      assert(Array.isArray(portfolioValuePreflight?.issues), `T1 portfolio-value preflight issues shape invalid: ${jsonText(portfolioValuePreflight)}`);
      console.log(`[${formatTestId('T1')}] portfolio-value candidate preflight passed`);
    }

    if (isTestSelected(requestedTests, 'TQ')) {
      console.log(`\n=== ${formatTestId('TQ')}: enqueue process-accumulated and verify queue runner drains it ===`);
      const wakeup = await enqueueProcessAccumulatedWakeup(BOARD_ID);
      console.log(`[${formatTestId('TQ')}] enqueued process-queue message ${wakeup.id}`);

      let drained = false;
      let attemptsUsed = 0;
      let lastQueueDoc = null;
      let sawLease = false;
      const progress = createPollProgress(`process-queue message ${wakeup.id} to drain`);
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        attemptsUsed = attempt;
        progress.tick();
        lastQueueDoc = await readProcessAccumulatedWakeup(BOARD_ID, wakeup.id);
        if (!lastQueueDoc) {
          drained = true;
          break;
        }
        if (lastQueueDoc.dead === true) {
          break;
        }
        if (lastQueueDoc.leaseToken) {
          sawLease = true;
        }
        await sleep(500);
      }
      progress.done();

      assert(
        drained,
        lastQueueDoc?.dead === true
          ? `TQ process-queue wakeup dead-lettered instead of draining: ${jsonText(lastQueueDoc)}`
          : sawLease
            ? `TQ process-queue wakeup was leased by queue runner but not acked before timeout: ${jsonText(lastQueueDoc)}`
          : `TQ process-queue wakeup was not drained by queue runner: ${jsonText(lastQueueDoc)}`,
      );
      console.log(`[${formatTestId('TQ')}] queue runner drained process-queue message in ${attemptsUsed} poll(s)`);
    }

    if (isTestSelected(requestedTests, 'TT')) {
      console.log(`\n=== ${formatTestId('TT')}: enqueue dummy task-executor request and verify queue runner picks it up ===`);
      const wakeup = await enqueueDummyTaskExecutorRequest(BOARD_ID);
      console.log(`[${formatTestId('TT')}] enqueued task-executor dummy request ${wakeup.id} marker=${wakeup.marker}`);

      let drained = false;
      let attemptsUsed = 0;
      let lastQueueDoc = null;
      let sawLease = false;
      const progress = createPollProgress(`task-executor dummy request ${wakeup.id} to drain`);
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        attemptsUsed = attempt;
        progress.tick();
        lastQueueDoc = await readDummyTaskExecutorRequest(BOARD_ID, wakeup.id);
        if (!lastQueueDoc) {
          drained = true;
          break;
        }
        if (lastQueueDoc.dead === true) {
          break;
        }
        if (lastQueueDoc.leaseToken) {
          sawLease = true;
        }
        await sleep(500);
      }
      progress.done();

      assert(
        drained,
        lastQueueDoc?.dead === true
          ? `TT task-executor dummy request dead-lettered instead of draining: ${jsonText(lastQueueDoc)}`
          : sawLease
            ? `TT task-executor dummy request was leased by queue runner but not acked before timeout: ${jsonText(lastQueueDoc)}`
            : `TT task-executor dummy request was not drained by queue runner: ${jsonText(lastQueueDoc)}`,
      );
      console.log(`[${formatTestId('TT')}] task-executor dummy request drained in ${attemptsUsed} poll(s)`);
    }

    if (isTestSelected(requestedTests, 'T2')) {
      console.log(`\n=== ${formatTestId('T2')}: re-upsert ${PORTFOLIO_CARD_ID}, seed ${MARKET_PRICES_CARD_ID} + ${PORTFOLIO_VALUE_CARD_ID}, and verify total value ===`);

      console.log(`[${formatTestId('T2')}] step 1/7: upserting ${PORTFOLIO_CARD_ID}`);
      const portfolioUpsertStartedAt = Date.now();
      const portfolioUpsertResult = await callMcp('manage.upsert-card', {
        card_id: PORTFOLIO_CARD_ID,
        candidate_card_content: portfolioT2SeedCard,
      });
      expectMcpSuccess(portfolioUpsertResult, 'T2 manage.upsert-card portfolio with extra row');
      console.log(`[${formatTestId('T2')}] upserted card ${PORTFOLIO_CARD_ID} in ${elapsedMs(portfolioUpsertStartedAt)}ms`);

      console.log(`[${formatTestId('T2')}] step 2/7: upserting ${MARKET_PRICES_CARD_ID}`);
      const marketPricesUpsertStartedAt = Date.now();
      const marketPricesUpsertResult = await callMcp('manage.upsert-card', {
        card_id: MARKET_PRICES_CARD_ID,
        candidate_card_content: marketPricesSeedCard,
      });
      expectMcpSuccess(marketPricesUpsertResult, 'T2 manage.upsert-card market-prices');
      console.log(`[${formatTestId('T2')}] upserted card ${MARKET_PRICES_CARD_ID} in ${elapsedMs(marketPricesUpsertStartedAt)}ms`);

      console.log(`[${formatTestId('T2')}] step 3/7: upserting ${PORTFOLIO_VALUE_CARD_ID}`);
      const portfolioValueUpsertStartedAt = Date.now();
      const portfolioValueUpsertResult = await callMcp('manage.upsert-card', {
        card_id: PORTFOLIO_VALUE_CARD_ID,
        candidate_card_content: portfolioValueSeedCard,
      });
      expectMcpSuccess(portfolioValueUpsertResult, 'T2 manage.upsert-card portfolio-value');
      console.log(`[${formatTestId('T2')}] upserted card ${PORTFOLIO_VALUE_CARD_ID} in ${elapsedMs(portfolioValueUpsertStartedAt)}ms`);
      createdCardIds.push(PORTFOLIO_CARD_ID, MARKET_PRICES_CARD_ID, PORTFOLIO_VALUE_CARD_ID);

      console.log(`[${formatTestId('T2')}] step 4/7: waiting for ${MARKET_PRICES_CARD_ID} and ${PORTFOLIO_VALUE_CARD_ID} to complete`);
      const t1Poll = await pollBoardStatus(callMcp, 10, 1000, (statusData) => {
        const marketCard = findBoardStatusCard(statusData, MARKET_PRICES_CARD_ID);
        const portfolioValueCard = findBoardStatusCard(statusData, PORTFOLIO_VALUE_CARD_ID);
        return marketCard
          && portfolioValueCard
          && String(marketCard.status || '') === 'completed'
          && String(portfolioValueCard.status || '') === 'completed';
      }, 'dependent cards to complete');
      assert(
        t1Poll.matched,
        `T2 timed out waiting for dependent cards to complete: ${jsonText(t1Poll.statusData)}`,
      );
      console.log(`[${formatTestId('T2')}] dependent cards completed in ${t1Poll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T2')}] step 5/7: reading stored portfolio card ${PORTFOLIO_CARD_ID}`);
      const storedPortfolio = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T2 manage.read-card portfolio',
        ),
      );
      assert(storedPortfolio, `T2 manage.read-card returned no stored card for ${PORTFOLIO_CARD_ID}`);
      console.log(`[${formatTestId('T2')}] read stored card ${PORTFOLIO_CARD_ID}`);

      console.log(`[${formatTestId('T2')}] step 6/7: reading runtime for ${MARKET_PRICES_CARD_ID} and ${PORTFOLIO_VALUE_CARD_ID}`);
      const marketRuntime = expectMcpSuccess(
        await callMcp('inspect.card-definition-and-runtime', { card_id: MARKET_PRICES_CARD_ID }),
        'T2 inspect.card-definition-and-runtime market-prices',
      );
      const portfolioValueRuntime = expectMcpSuccess(
        await callMcp('inspect.card-definition-and-runtime', { card_id: PORTFOLIO_VALUE_CARD_ID }),
        'T2 inspect.card-definition-and-runtime portfolio-value',
      );
      assert(marketRuntime, `T2 inspect.card-definition-and-runtime returned no runtime for ${MARKET_PRICES_CARD_ID}`);
      assert(portfolioValueRuntime, `T2 inspect.card-definition-and-runtime returned no runtime for ${PORTFOLIO_VALUE_CARD_ID}`);
      console.log(`[${formatTestId('T2')}] read runtime for ${MARKET_PRICES_CARD_ID} and ${PORTFOLIO_VALUE_CARD_ID}`);

      const holdings = storedPortfolio?.card_data?.holdings;
      const priceRows = portfolioValueRuntime?.runtime_data?.requires?.quotes_tc2?.quoteResponse?.result
        || marketRuntime?.runtime_data?.provides?.quotes_tc2?.quoteResponse?.result
        || marketRuntime?.runtime_data?.computed_values?.normalizedQuotes?.quoteResponse?.result
        || marketRuntime?.runtime_data?.computed_values?.prices
        || [];
      const positions = portfolioValueRuntime?.runtime_data?.computed_values?.positions;
      const totalValue = Number(portfolioValueRuntime?.runtime_data?.computed_values?.totalValue);

      assert(Array.isArray(holdings) && holdings.length > 0, 'T2 holdings missing from stored portfolio card');
      assert(Array.isArray(priceRows) && priceRows.length > 0, 'T2 market-prices runtime rows missing');
      assert(Array.isArray(positions) && positions.length > 0, 'T2 portfolio-value positions missing');
      assert(Number.isFinite(totalValue), 'T2 portfolio-value totalValue missing');
      console.log(`[${formatTestId('T2')}] assertion inputs ok: holdings=${holdings.length}, priceRows=${priceRows.length}, positions=${positions.length}, totalValue=${roundMoney(totalValue)}`);

      console.log(`[${formatTestId('T2')}] step 7/7: comparing computed total value against the card JSONata using the same quote payload as runtime`);
      const expectedPortfolioValue = computePortfolioValueViaCardJsonata(portfolioValueSeedCard, holdings, priceRows);
      const expectedTotal = expectedPortfolioValue.totalValue;
      assert(
        roundMoney(totalValue) === expectedTotal,
        `T2 totalValue mismatch: expected ${expectedTotal}, got ${roundMoney(totalValue)}`,
      );
      assert(
        JSON.stringify(canonicalizeJson(positions)) === JSON.stringify(canonicalizeJson(expectedPortfolioValue.positions)),
        `T2 positions mismatch: expected ${jsonText(expectedPortfolioValue.positions)}, got ${jsonText(positions)}`,
      );
      console.log(`[${formatTestId('T2')}] total portfolio value verified: ${expectedTotal}`);
    }

    if (isTestSelected(requestedTests, 'T3')) {
      console.log(`\n=== ${formatTestId('T3')}: probe chat send + persisted/controlplane lifecycle ===`);

      console.log(`[${formatTestId('T3')}] step 0/7: upserting ${PORTFOLIO_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioSeedCard,
        }),
        'T3 manage.upsert-card portfolio',
      );
      createdCardIds.push(PORTFOLIO_CARD_ID);

      const turnId = makeTurnId();
      const promptText = 'hi testing';
      const probeText = buildProbeChatText(promptText, 'echo');

      console.log(`[${formatTestId('T3')}] step 1/7: sending chat turn ${turnId}`);
      expectMcpSuccess(
        await callAction('chat-send', PORTFOLIO_CARD_ID, {
          text: probeText,
          probe: 'echo',
          'turn-id': turnId,
        }),
        'T3 chat-send',
      );

      console.log(`[${formatTestId('T3')}] step 2/7: verifying user chat entry is stored`);
      const userMessagesPoll = await pollChatMessages(
        PORTFOLIO_CARD_ID,
        turnId,
        5,
        500,
        (messages) => messages.some((message) => message?.role === 'user' && String(message?.text || '') === promptText),
        `user chat message for turn ${turnId}`,
      );
      assert(userMessagesPoll.matched, `T3 user message not found for turn ${turnId}: ${jsonText(userMessagesPoll.messages)}`);
      console.log(`[${formatTestId('T3')}] user chat entry stored in ${userMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T3')}] step 3/7: verifying chat processing turns on`);
      const processingOnPoll = await pollChatProcessing(
        PORTFOLIO_CARD_ID,
        true,
        5,
        1000,
        `chat processing on for ${PORTFOLIO_CARD_ID}`,
      );
      assert(processingOnPoll.matched, `T3 chat processing did not turn on for ${PORTFOLIO_CARD_ID}; active=${processingOnPoll.active}`);
      console.log(`[${formatTestId('T3')}] chat processing turned on in ${processingOnPoll.attemptsUsed} poll(s)`);

      const expectedProbeReply = `Echo: ${promptText}`;

      console.log(`[${formatTestId('T3')}] step 4/7: waiting for probe final reply`);
      const assistantMessagesPoll = await pollChatMessages(
        PORTFOLIO_CARD_ID,
        turnId,
        12,
        1000,
        (messages) => messages.some((message) => message?.role === 'assistant' && String(message?.text || '').includes(expectedProbeReply)),
        `probe final reply for turn ${turnId}`,
      );
      assert(assistantMessagesPoll.matched, `T3 probe final reply not found for turn ${turnId}: ${jsonText(assistantMessagesPoll.messages)}`);
      const assistantMessage = assistantMessagesPoll.messages.find((message) => message?.role === 'assistant' && String(message?.text || '').includes(expectedProbeReply));
      assert(assistantMessage, `T3 probe final reply missing after successful poll for turn ${turnId}`);
      console.log(`[${formatTestId('T3')}] probe final reply stored in ${assistantMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T3')}] step 5/7: verifying chat processing turns off`);
      const processingOffPoll = await pollChatProcessing(
        PORTFOLIO_CARD_ID,
        false,
        12,
        1000,
        `chat processing off for ${PORTFOLIO_CARD_ID}`,
      );
      assert(processingOffPoll.matched, `T3 chat processing did not turn off for ${PORTFOLIO_CARD_ID}; active=${processingOffPoll.active}`);
      console.log(`[${formatTestId('T3')}] chat processing turned off in ${processingOffPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T3')}] step 6/7: verifying final inspected messages`);
      const finalMessages = await readChatMessages(PORTFOLIO_CARD_ID, turnId);
      const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
      const finalAssistantMessage = finalMessages.find((message) => message?.role === 'assistant');
      assert(finalUserMessage, `T3 final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(finalAssistantMessage, `T3 final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(String(finalUserMessage.text || '') === promptText, `T3 final user text mismatch: ${jsonText(finalUserMessage)}`);
      assert(String(finalAssistantMessage.text || '').includes(expectedProbeReply), `T3 final probe reply text mismatch: ${jsonText(finalAssistantMessage)}`);
      console.log(`[${formatTestId('T3')}] final probe reply: ${String(finalAssistantMessage.text || '')}`);

      console.log(`[${formatTestId('T3')}] step 7/7: verifying live /sse board-state bootstrap`);
      resetBoardSseState();
      await ensureBoardSseConnection(PORTFOLIO_CARD_ID);
      const bootstrapPayload = await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `T3 initial /sse payload for ${PORTFOLIO_CARD_ID}`,
      );
      const bootstrapSummary = bootstrapPayload?.statusSnapshot?.summary || sseState.statusSummary;
      assert(bootstrapSummary, `T3 live /sse summary missing: ${jsonText(bootstrapPayload)}`);
      const bootstrapCompletedStatus = await waitForSseCompletedCard(PORTFOLIO_CARD_ID, 15_000, `T3 SSE completed status for ${PORTFOLIO_CARD_ID}`);
      assert(bootstrapCompletedStatus.card, `T3 live /sse payload missing ${PORTFOLIO_CARD_ID}: ${jsonText(bootstrapCompletedStatus.statusData)}`);
      assert(Number(bootstrapSummary.completed || 0) >= 1, `T3 expected completed count >= 1 after upsert: ${jsonText(bootstrapSummary)}`);
      await closeBoardSseConnection({ clearChatEvents: true });
    }

    if (isTestSelected(requestedTests, 'T4')) {
      console.log(`\n=== ${formatTestId('T4')}: probe attachment chat + persisted/controlplane lifecycle ===`);

      console.log(`[${formatTestId('T4')}] step 0/8: upserting ${T4_CHAT_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: T4_CHAT_CARD_ID,
          candidate_card_content: t4ChatSeedCard,
        }),
        'T4 manage.upsert-card portfolio',
      );
      createdCardIds.push(T4_CHAT_CARD_ID);

      const turnId = `t4${makeTurnId()}`;
      const promptText = 'what is the content in the attached file';
      const probeText = buildProbeChatText(promptText, 'echoattach');
      const expectedProbeReply = 'what is the capital of japan';

      console.log(`[${formatTestId('T4')}] step 1/8: adding chat attachment for turn ${turnId}`);
      const uploadResult = expectMcpSuccess(
        await callControlplaneMcp('manage.add-chat-attachment', {
          card_id: T4_CHAT_CARD_ID,
          turn_id: turnId,
          file_name: 't4-probe.txt',
          content_type: 'text/plain; charset=utf-8',
          text: expectedProbeReply,
        }),
        'T4 manage.add-chat-attachment',
      );
      const uploadedFile = Array.isArray(uploadResult?.files) ? uploadResult.files[0] : null;
      assert(uploadedFile && typeof uploadedFile === 'object', 'T4 upload response missing file metadata');
      assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), 'T4 uploaded file metadata should not expose path');

      const cardAfterUpload = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: T4_CHAT_CARD_ID }),
          'T4 manage.read-card after upload',
        ),
      );
      const storedFiles = Array.isArray(cardAfterUpload?.card_data?.files) ? cardAfterUpload.card_data.files : [];
      const storedFile = storedFiles.find((file) => String(file?.stored_name || '') === String(uploadedFile?.stored_name || ''));
      assert(!!storedFile, 'T4 stored file metadata missing after upload');
      assert(storedFile?.chat === true, 'T4 stored file should be marked as chat-origin');
      assert(!Object.prototype.hasOwnProperty.call(storedFile || {}, 'path'), 'T4 stored file metadata should not expose path');

      const afterUploadMessages = await readChatMessages(T4_CHAT_CARD_ID, turnId);
      const uploadSystemMessage = afterUploadMessages.find((message) => message?.role === 'system');
      assert(!!uploadSystemMessage, 'T4 upload protocol missing system chat message');
      assert(String(uploadSystemMessage?.text || '').toLowerCase().includes('file uploaded:'), 'T4 upload system message does not describe uploaded file');

      console.log(`[${formatTestId('T4')}] step 2/8: sending probe chat turn ${turnId} with attachment`);
      expectMcpSuccess(
        await callAction('chat-send', T4_CHAT_CARD_ID, {
          text: probeText,
          probe: 'echoattach',
          'turn-id': turnId,
        }),
        'T4 chat-send',
      );

      console.log(`[${formatTestId('T4')}] step 3/8: verifying user chat entry is stored`);
      const userMessagesPoll = await pollChatMessages(
        T4_CHAT_CARD_ID,
        turnId,
        5,
        500,
        (messages) => messages.some((message) => message?.role === 'user' && String(message?.text || '') === promptText),
        `user chat message for turn ${turnId}`,
      );
      assert(userMessagesPoll.matched, `T4 user message not found for turn ${turnId}: ${jsonText(userMessagesPoll.messages)}`);
      console.log(`[${formatTestId('T4')}] user chat entry stored in ${userMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T4')}] step 4/8: verifying chat processing turns on`);
      const processingOnPoll = await pollChatProcessing(
        T4_CHAT_CARD_ID,
        true,
        5,
        1000,
        `chat processing on for ${T4_CHAT_CARD_ID}`,
      );
      assert(processingOnPoll.matched, `T4 chat processing did not turn on for ${T4_CHAT_CARD_ID}; active=${processingOnPoll.active}`);
      console.log(`[${formatTestId('T4')}] chat processing turned on in ${processingOnPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T4')}] step 5/8: waiting for probe final reply`);
      const assistantMessagesPoll = await pollChatMessages(
        T4_CHAT_CARD_ID,
        turnId,
        12,
        1000,
        (messages) => messages.some((message) => message?.role === 'assistant' && String(message?.text || '').includes(expectedProbeReply)),
        `probe final reply for turn ${turnId}`,
      );
      assert(assistantMessagesPoll.matched, `T4 probe final reply not found for turn ${turnId}: ${jsonText(assistantMessagesPoll.messages)}`);
      const assistantMessage = assistantMessagesPoll.messages.find((message) => message?.role === 'assistant' && String(message?.text || '').includes(expectedProbeReply));
      assert(assistantMessage, `T4 probe final reply missing after successful poll for turn ${turnId}`);
      console.log(`[${formatTestId('T4')}] probe final reply stored in ${assistantMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T4')}] step 6/8: verifying chat processing turns off`);
      const processingOffPoll = await pollChatProcessing(
        T4_CHAT_CARD_ID,
        false,
        12,
        1000,
        `chat processing off for ${T4_CHAT_CARD_ID}`,
      );
      assert(processingOffPoll.matched, `T4 chat processing did not turn off for ${T4_CHAT_CARD_ID}; active=${processingOffPoll.active}`);
      console.log(`[${formatTestId('T4')}] chat processing turned off in ${processingOffPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T4')}] step 7/8: verifying final inspected messages`);
      const finalMessages = await readChatMessages(T4_CHAT_CARD_ID, turnId);
      const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
      const finalAssistantMessage = finalMessages.find((message) => message?.role === 'assistant');
      assert(finalUserMessage, `T4 final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(finalAssistantMessage, `T4 final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(String(finalUserMessage.text || '') === promptText, `T4 final user text mismatch: ${jsonText(finalUserMessage)}`);
      const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
      assert(turnSystemMessage, `T4 turn missing system attachment message: ${jsonText(finalMessages)}`);
      assert(String(finalAssistantMessage.text || '').includes(expectedProbeReply), `T4 final probe reply text mismatch: ${jsonText(finalAssistantMessage)}`);
      console.log(`[${formatTestId('T4')}] final probe reply: ${String(finalAssistantMessage.text || '')}`);

      console.log(`[${formatTestId('T4')}] step 8/8: final probe reply with attachment contents passed`);
    }

    if (isTestSelected(requestedTests, 'TS')) {
      console.log(`\n=== ${formatTestId('TS')}: probe attachment chat + watchparty SSE proof ===`);

      console.log(`[${formatTestId('TS')}] step 0/9: upserting ${PORTFOLIO_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioSeedCard,
        }),
        'TS manage.upsert-card portfolio',
      );
      createdCardIds.push(PORTFOLIO_CARD_ID);
      let tsChatSubscribed = false;
      let tsAgentOutputSubscribed = false;
      let tsAgentToolsSubscribed = false;
      try {
        console.log(`[${formatTestId('TS')}] step 1/11: subscribing chat + watchparty SSE for ${PORTFOLIO_CARD_ID}`);
        await closeBoardSseConnection({ clearChatEvents: true });
        await ensureChatSseSubscription(PORTFOLIO_CARD_ID);
        tsChatSubscribed = true;
        await subscribeWatchChannel(PORTFOLIO_CARD_ID, 'agent-output');
        tsAgentOutputSubscribed = true;
        await subscribeWatchChannel(PORTFOLIO_CARD_ID, 'agent-tools');
        tsAgentToolsSubscribed = true;

        console.log(`[${formatTestId('TS')}] step 2/11: waiting for live /sse bootstrap payload`);
        await waitUntil(
          () => sseState.initialPayload || false,
          15_000,
          `TS initial /sse payload for ${PORTFOLIO_CARD_ID}`,
        );
        const bootstrapSummary = await waitForSseSummary(15_000, `TS SSE summary for ${PORTFOLIO_CARD_ID}`);
        assert(bootstrapSummary, `TS live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);

        console.log(`[${formatTestId('TS')}] step 3/11: waiting for ${PORTFOLIO_CARD_ID} to appear completed in SSE status`);
        const completedStatus = await waitForSseCompletedCard(PORTFOLIO_CARD_ID, 15_000, `TS SSE completed status for ${PORTFOLIO_CARD_ID}`);
        const completedSummary = await waitUntil(() => {
          const summary = sseState.statusSummary;
          return Number(summary?.completed || 0) >= 1 ? summary : false;
        }, 15_000, `TS SSE completed summary for ${PORTFOLIO_CARD_ID}`);
        const bootstrapCard = completedStatus.card;
        assert(completedSummary, `TS live /sse summary missing after status wait: ${jsonText(completedStatus.statusData)}`);
        assert(Number(completedSummary.completed || 0) >= 1, `TS expected completed count >= 1 after upsert: ${jsonText(completedSummary)}`);
        assert(bootstrapCard && String(bootstrapCard.status || '') === 'completed', `TS expected ${PORTFOLIO_CARD_ID} completed in SSE built state: ${jsonText(completedStatus.statusData)}`);

        const turnId = `ts${makeTurnId()}`;
        const promptText = 'what is the content in the attached file';
        const probeText = buildProbeChatText(promptText, 'echoattach');
        const expectedProbeReply = 'what is the capital of japan';

        console.log(`[${formatTestId('TS')}] step 4/11: adding chat attachment for turn ${turnId}`);
        const uploadResult = expectMcpSuccess(
          await callControlplaneMcp('manage.add-chat-attachment', {
            card_id: PORTFOLIO_CARD_ID,
            turn_id: turnId,
            file_name: 'ts-probe.txt',
            content_type: 'text/plain; charset=utf-8',
            text: 'what is the capital of japan',
          }),
          'TS manage.add-chat-attachment',
        );
        const uploadedFile = Array.isArray(uploadResult?.files) ? uploadResult.files[0] : null;
        assert(uploadedFile && typeof uploadedFile === 'object', 'TS upload response missing file metadata');
        assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), 'TS uploaded file metadata should not expose path');

        const cardAfterUpload = readStoredCard(
          expectMcpSuccess(
            await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
            'TS manage.read-card after upload',
          ),
        );
        const storedFiles = Array.isArray(cardAfterUpload?.card_data?.files) ? cardAfterUpload.card_data.files : [];
        const storedFile = storedFiles.find((file) => String(file?.stored_name || '') === String(uploadedFile?.stored_name || ''));
        assert(!!storedFile, 'TS stored file metadata missing after upload');
        assert(storedFile?.chat === true, 'TS stored file should be marked as chat-origin');
        assert(!Object.prototype.hasOwnProperty.call(storedFile || {}, 'path'), 'TS stored file metadata should not expose path');

        const afterUploadMessages = await readChatMessages(PORTFOLIO_CARD_ID, turnId);
        const uploadSystemMessage = afterUploadMessages.find((message) => message?.role === 'system');
        assert(!!uploadSystemMessage, 'TS upload protocol missing system chat message');
        assert(String(uploadSystemMessage?.text || '').toLowerCase().includes('file uploaded:'), 'TS upload system message does not describe uploaded file');

        const eventStart = sseState.chatEvents.length;

        console.log(`[${formatTestId('TS')}] step 5/11: sending probe chat turn ${turnId} with attachment`);
        expectMcpSuccess(
          await callAction('chat-send', PORTFOLIO_CARD_ID, {
            text: probeText,
            probe: 'echoattach',
            'turn-id': turnId,
          }),
          'TS chat-send',
        );

        console.log(`[${formatTestId('TS')}] step 6/11: proving the chat SSE lifecycle for this turn`);
        let bouquet;
        try {
          bouquet = await waitForChatTurnState({
            eventStart,
            turnId,
            timeoutMs: 45_000,
            label: `TS chat turn bouquet for turn ${turnId}`,
            predicate: (currentBouquet) => {
              const hasUser = currentBouquet.userMessages.some((message) => String(message?.text || '') === promptText);
              const hasSystem = currentBouquet.systemMessages.some((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
              const hasAssistant = currentBouquet.assistantMessages.some((message) => String(message?.text || '').includes(expectedProbeReply));
              return currentBouquet.processingOnSeen && currentBouquet.processingDoneSeen && hasUser && hasSystem && hasAssistant;
            },
          });
        } catch (err) {
          const debugEvents = sseState.chatEvents.slice(eventStart).map((event, idx) => ({
            idx,
            processing: event?.processing,
            messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
            tailMessages: Array.isArray(event?.messages)
              ? event.messages.slice(-3).map((m) => ({ role: m?.role, turn: m?.turn, text: String(m?.text || '').slice(0, 60) }))
              : [],
          }));
          console.error('[TS DEBUG] SSE events captured (after eventStart):', JSON.stringify(debugEvents, null, 2));
          const persisted = await readChatMessages(PORTFOLIO_CARD_ID, turnId).catch((e) => ({ error: String(e?.message || e) }));
          console.error('[TS DEBUG] Persisted messages for turn:', JSON.stringify(persisted, null, 2));
          throw err;
        }

        console.log(`[${formatTestId('TS')}] step 7/11: verifying the SSE notification chronology for this turn`);
        const expectedProbeReplyPattern = new RegExp(expectedProbeReply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        assert(bouquet.processingOnSeen, `TS bouquet missing processing-on notification for turn ${turnId}`);
        assert(bouquet.processingDoneSeen, `TS bouquet missing processing-done notification for turn ${turnId}`);
        const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
        assert(bouquetUserMessage, `TS bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAttachmentSystemMessage = bouquet.systemMessages.find((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(bouquetAttachmentSystemMessage, `TS bouquet missing attachment system message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => expectedProbeReplyPattern.test(String(message?.text || '')));
        assert(bouquetAssistantMessage, `TS bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

        console.log(`[${formatTestId('TS')}] step 8/11: verifying reduced watchparty agent-output progress`);
        const agentOutputText = await waitForWatchPartyText({
          cardId: PORTFOLIO_CARD_ID,
          channel: 'agent-output',
          timeoutMs: 20_000,
          label: `TS agent-output watchparty for turn ${turnId}`,
          predicate: (text) => text.includes(PROBE_PROGRESS_LINE),
        });
        assert(agentOutputText.includes(PROBE_PROGRESS_LINE), `TS agent-output watchparty missing probe progress line: ${jsonText(agentOutputText)}`);

        console.log(`[${formatTestId('TS')}] step 9/11: verifying reduced watchparty agent-tools invocation`);
        const agentToolsText = await waitForWatchPartyText({
          cardId: PORTFOLIO_CARD_ID,
          channel: 'agent-tools',
          timeoutMs: 20_000,
          label: `TS agent-tools watchparty for turn ${turnId}`,
          predicate: (text) => text.includes(STAGE_AI_RESPONSE_TOOL_LABEL),
        });
        assert(agentToolsText.includes(STAGE_AI_RESPONSE_TOOL_LABEL), `TS agent-tools watchparty missing stage-ai-response invocation: ${jsonText(agentToolsText)}`);

        console.log(`[${formatTestId('TS')}] step 10/11: verifying persisted turn contents`);
        const finalMessages = await readChatMessages(PORTFOLIO_CARD_ID, turnId);
        const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
        const finalAssistantMessage = finalMessages.find((message) => message?.role === 'assistant');
        assert(finalUserMessage, `TS final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(finalAssistantMessage, `TS final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(String(finalUserMessage.text || '') === promptText, `TS final user text mismatch: ${jsonText(finalUserMessage)}`);
        const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(turnSystemMessage, `TS turn missing system attachment message: ${jsonText(finalMessages)}`);
        assert(String(finalAssistantMessage.text || '').includes(expectedProbeReply), `TS final probe reply text mismatch: ${jsonText(finalAssistantMessage)}`);

        console.log(`[${formatTestId('TS')}] step 11/11: final probe reply with attachment contents passed`);
        console.log(`[${formatTestId('TS')}] final probe reply: ${String(finalAssistantMessage.text || '')}`);
      } finally {
        if (tsAgentToolsSubscribed) {
          try {
            await unsubscribeWatchChannel(PORTFOLIO_CARD_ID, 'agent-tools');
          } catch (err) {
            console.warn(`[${formatTestId('TS')}] agent-tools watch unsubscribe failed: ${String(err?.message || err)}`);
          }
        }
        if (tsAgentOutputSubscribed) {
          try {
            await unsubscribeWatchChannel(PORTFOLIO_CARD_ID, 'agent-output');
          } catch (err) {
            console.warn(`[${formatTestId('TS')}] agent-output watch unsubscribe failed: ${String(err?.message || err)}`);
          }
        }
        if (tsChatSubscribed) {
          console.log(`[${formatTestId('TS')}] cleanup: unsubscribing chat SSE for ${PORTFOLIO_CARD_ID}`);
          try {
            await unsubscribeChatSseSubscription(PORTFOLIO_CARD_ID);
          } catch (err) {
            console.warn(`[${formatTestId('TS')}] chat SSE unsubscribe failed: ${String(err?.message || err)}`);
          }
        }
      }
    }

    async function ensureHostedParallelSseReady(seedCardId) {
      await closeBoardSseConnection({ clearChatEvents: true });
      await ensureBoardSseConnection(seedCardId);
      const bootstrapSummary = await waitForSseSummary(15_000, `hosted parallel SSE summary for ${seedCardId}`);
      assert(bootstrapSummary, `Hosted parallel live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);
    }

    async function verifyHostedCardOnSharedSse(cardId, testId) {
      const finalBootstrapSummary = await waitForSseSummary(15_000, `${testId} final SSE summary for ${cardId}`);
      assert(finalBootstrapSummary, `${testId} final live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);
    }

    async function runHostedAssistantSmoke({
      testId,
      title,
      cardId,
      seedCard,
      promptText,
      probeFlavor,
      turnPrefix,
      assistantPattern,
      attachment,
    }) {
      console.log(`\n=== ${formatTestId(testId)}: ${title} ===`);

      console.log(`[${formatTestId(testId)}] step 0/6: upserting ${cardId} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: cardId,
          candidate_card_content: seedCard,
        }),
        `${testId} manage.upsert-card portfolio`,
      );
      createdCardIds.push(cardId);

      const turnId = `${turnPrefix}${makeTurnId()}`;
      const markedPromptText = buildProbeChatText(promptText, probeFlavor);

      if (attachment) {
        console.log(`[${formatTestId(testId)}] step 1/6: adding chat attachment for turn ${turnId}`);
        const uploadResult = expectMcpSuccess(
          await callControlplaneMcp('manage.add-chat-attachment', {
            card_id: cardId,
            turn_id: turnId,
            file_name: attachment.fileName,
            content_type: 'text/plain; charset=utf-8',
            text: attachment.text,
          }),
          `${testId} manage.add-chat-attachment`,
        );
        const uploadedFile = Array.isArray(uploadResult?.files) ? uploadResult.files[0] : null;
        assert(uploadedFile && typeof uploadedFile === 'object', `${testId} upload response missing file metadata`);
        assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), `${testId} uploaded file metadata should not expose path`);

        const cardAfterUpload = readStoredCard(
          expectMcpSuccess(
            await callMcp('manage.read-card', { card_id: cardId }),
            `${testId} manage.read-card after upload`,
          ),
        );
        const storedFiles = Array.isArray(cardAfterUpload?.card_data?.files) ? cardAfterUpload.card_data.files : [];
        const storedFile = storedFiles.find((file) => String(file?.stored_name || '') === String(uploadedFile?.stored_name || ''));
        assert(!!storedFile, `${testId} stored file metadata missing after upload`);
        assert(storedFile?.chat === true, `${testId} stored file should be marked as chat-origin`);
        assert(!Object.prototype.hasOwnProperty.call(storedFile || {}, 'path'), `${testId} stored file metadata should not expose path`);

        const afterUploadMessages = await readChatMessages(cardId, turnId);
        const uploadSystemMessage = afterUploadMessages.find((message) => message?.role === 'system');
        assert(!!uploadSystemMessage, `${testId} upload protocol missing system chat message`);
        assert(String(uploadSystemMessage?.text || '').toLowerCase().includes('file uploaded:'), `${testId} upload system message does not describe uploaded file`);
      }

      console.log(`[${formatTestId(testId)}] step 2/6: sending hosted chat turn ${turnId}`);
      expectMcpSuccess(
        await callAction('chat-send', cardId, {
          text: markedPromptText,
          'turn-id': turnId,
        }),
        `${testId} chat-send`,
      );

      console.log(`[${formatTestId(testId)}] step 3/6: verifying user chat entry is stored`);
      const userMessagesPoll = await pollChatMessages(
        cardId,
        turnId,
        5,
        500,
        (messages) => messages.some((message) => message?.role === 'user' && String(message?.text || '') === promptText),
        `user chat message for turn ${turnId}`,
      );
      assert(userMessagesPoll.matched, `${testId} user message not found for turn ${turnId}: ${jsonText(userMessagesPoll.messages)}`);
      console.log(`[${formatTestId(testId)}] user chat entry stored in ${userMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId(testId)}] step 4/6: waiting for final assistant reply in persisted messages`);
      const assistantMessagesPoll = await pollChatMessages(
        cardId,
        turnId,
        Math.max(12, Math.ceil(NON_PROBE_RESPONSE_TIMEOUT_MS / 1000)),
        1000,
        (messages) => messages.some((message) => message?.role === 'assistant' && assistantPattern.test(String(message?.text || ''))),
        `final assistant reply for turn ${turnId}`,
      );
      assert(assistantMessagesPoll.matched, `${testId} final assistant reply not found for turn ${turnId}: ${jsonText(assistantMessagesPoll.messages)}`);

      console.log(`[${formatTestId(testId)}] step 5/6: verifying persisted turn contents`);
      const finalMessages = await readChatMessages(cardId, turnId);
      const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
      const finalAssistantMessage = [...finalMessages].reverse().find((message) => message?.role === 'assistant');
      assert(finalUserMessage, `${testId} final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(finalAssistantMessage, `${testId} final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(String(finalUserMessage.text || '') === promptText, `${testId} final user text mismatch: ${jsonText(finalUserMessage)}`);
      if (attachment) {
        const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(turnSystemMessage, `${testId} turn missing system attachment message: ${jsonText(finalMessages)}`);
      }
      assert(assistantPattern.test(String(finalAssistantMessage.text || '').trim()), `${testId} final assistant text mismatch: ${jsonText(finalAssistantMessage)}`);
      const finalProcessingOffPoll = await pollChatProcessing(
        cardId,
        false,
        Math.max(12, Math.ceil(NON_PROBE_RESPONSE_TIMEOUT_MS / 1000)),
        1000,
        `chat processing off for ${cardId}`,
      );
      assert(finalProcessingOffPoll.matched, `${testId} chat processing did not turn off for ${cardId}; active=${finalProcessingOffPoll.active}`);
      console.log(`[${formatTestId(testId)}] final assistant reply: ${String(finalAssistantMessage.text || '')}`);

      console.log(`[${formatTestId(testId)}] step 6/6: verifying shared /sse board-state completion`);
      await verifyHostedCardOnSharedSse(cardId, testId);
    }

    const hostedParallelConfigs = [
      isTestSelected(requestedTests, 'T8') ? {
        testId: 'T8',
        title: 'real assistant chat over shared hosted SSE',
        cardId: T8_CHAT_CARD_ID,
        seedCard: t8ChatSeedCard,
        promptText: 'Just answer what is the capital of France. No fluff. No commentary. No markup. Respond in lower case in one word.',
        probeFlavor: 'copilot',
        turnPrefix: 't8copilot_',
        assistantPattern: /paris/i,
        attachment: null,
      } : null,
      isTestSelected(requestedTests, 'T9') ? {
        testId: 'T9',
        title: 'foundry-forced assistant chat over shared hosted SSE',
        cardId: T9_CHAT_CARD_ID,
        seedCard: t9ChatSeedCard,
        promptText: 'Just answer what is the capital of France. No fluff. No commentary. No markup. Respond in lower case in one word.',
        probeFlavor: 'foundry',
        turnPrefix: 't9foundry_',
        assistantPattern: /paris/i,
        attachment: null,
      } : null,
      isTestSelected(requestedTests, 'T8F') ? {
        testId: 'T8F',
        title: 'real assistant attachment chat over shared hosted SSE',
        cardId: T8F_CHAT_CARD_ID,
        seedCard: t8fChatSeedCard,
        promptText: 'Answer the question in attached file in one word lower case.',
        probeFlavor: 'copilot',
        turnPrefix: 't8f',
        assistantPattern: /^tokyo\b/i,
        attachment: {
          fileName: 't8f-question.txt',
          text: 'What is the capital of Japan',
        },
      } : null,
      isTestSelected(requestedTests, 'T9F') ? {
        testId: 'T9F',
        title: 'foundry-forced attachment chat over shared hosted SSE',
        cardId: T9F_CHAT_CARD_ID,
        seedCard: t9fChatSeedCard,
        promptText: 'Answer the matheamtical question in the attached file.  Only the final numerical answer in digits please',
        probeFlavor: 'foundry',
        turnPrefix: 't9f',
        assistantPattern: /^9\b/,
        attachment: {
          fileName: 't9f-question.txt',
          text: 'What is two plus three plus four?',
        },
      } : null,
    ].filter(Boolean);

    const runHostedTestsInParallel = hostedParallelConfigs.length > 1;

    if (runHostedTestsInParallel) {
      console.log(`\n=== Hosted chat smoke tests: running ${hostedParallelConfigs.map((config) => formatTestId(config.testId)).join(', ')} in parallel on shared /sse ===`);
      await ensureHostedParallelSseReady(hostedParallelConfigs[0].cardId);
      await Promise.all(hostedParallelConfigs.map((config) => runHostedAssistantSmoke(config)));
    }

    if (!runHostedTestsInParallel && isTestSelected(requestedTests, 'T8')) {
      await ensureHostedParallelSseReady(T8_CHAT_CARD_ID);
      await runHostedAssistantSmoke(hostedParallelConfigs.find((config) => config.testId === 'T8'));
    }

    if (!runHostedTestsInParallel && isTestSelected(requestedTests, 'T9')) {
      await ensureHostedParallelSseReady(T9_CHAT_CARD_ID);
      await runHostedAssistantSmoke(hostedParallelConfigs.find((config) => config.testId === 'T9'));
    }

    if (!runHostedTestsInParallel && isTestSelected(requestedTests, 'T8F')) {
      await ensureHostedParallelSseReady(T8F_CHAT_CARD_ID);
      await runHostedAssistantSmoke(hostedParallelConfigs.find((config) => config.testId === 'T8F'));
    }

    if (!runHostedTestsInParallel && isTestSelected(requestedTests, 'T9F')) {
      await ensureHostedParallelSseReady(T9F_CHAT_CARD_ID);
      await runHostedAssistantSmoke(hostedParallelConfigs.find((config) => config.testId === 'T9F'));
    }

    if (isTestSelected(requestedTests, 'TR')) {
      console.log(`\n=== ${formatTestId('TR')}: card refresh action + SSE refreshed/running/completed lifecycle ===`);

      let trSseConnected = false;
      try {
        console.log(`[${formatTestId('TR')}] step 0/6: seeding ${TR_PORTFOLIO_CARD_ID} so ${TR_MARKET_PRICES_CARD_ID} can resolve holdings`);
        expectMcpSuccess(
          await callMcp('manage.upsert-card', {
            card_id: TR_PORTFOLIO_CARD_ID,
            candidate_card_content: trPortfolioSeedCard,
          }),
          'TR manage.upsert-card portfolio',
        );
        createdCardIds.push(TR_PORTFOLIO_CARD_ID);

        console.log(`[${formatTestId('TR')}] step 1/6: subscribing board SSE before upserting ${TR_MARKET_PRICES_CARD_ID}`);
        await closeBoardSseConnection({ clearChatEvents: true });
        await ensureBoardSseConnection(TR_MARKET_PRICES_CARD_ID);
        trSseConnected = true;
        await waitForSseSummary(15_000, `TR SSE summary before ${TR_MARKET_PRICES_CARD_ID} upsert`);

        const refreshedEventStart = sseState.cardRefreshedEvents.length;

        console.log(`[${formatTestId('TR')}] step 2/6: upserting ${TR_MARKET_PRICES_CARD_ID}`);
        expectMcpSuccess(
          await callMcp('manage.upsert-card', {
            card_id: TR_MARKET_PRICES_CARD_ID,
            candidate_card_content: trMarketPricesSeedCard,
          }),
          'TR manage.upsert-card market-prices',
        );
        createdCardIds.push(TR_MARKET_PRICES_CARD_ID);

        console.log(`[${formatTestId('TR')}] step 3/6: waiting for SSE card_refreshed notification for ${TR_MARKET_PRICES_CARD_ID}`);
        const refreshedEvent = await waitForSseCardRefreshed(
          TR_MARKET_PRICES_CARD_ID,
          refreshedEventStart,
          15_000,
          `TR SSE card_refreshed for ${TR_MARKET_PRICES_CARD_ID}`,
        );
        assert(
          refreshedEvent && refreshedEvent.cardId === TR_MARKET_PRICES_CARD_ID,
          `TR card_refreshed notification missing for ${TR_MARKET_PRICES_CARD_ID}`,
        );

        await waitForSseCardStatus(TR_MARKET_PRICES_CARD_ID, 'completed', 0, 30_000, `TR ${TR_MARKET_PRICES_CARD_ID} initial completed`);

        const statusHistoryStart = sseState.statusHistory.length;

        console.log(`[${formatTestId('TR')}] step 4/6: issuing card refresh action for ${TR_MARKET_PRICES_CARD_ID}`);
        const refreshActionResult = await callAction('retrigger-card', TR_MARKET_PRICES_CARD_ID);
        assert(
          refreshActionResult.status === 200 && refreshActionResult.data?.status === 'success',
          `TR retrigger-card failed: HTTP ${refreshActionResult.status} ${jsonText(refreshActionResult.data)}`,
        );

        console.log(`[${formatTestId('TR')}] step 5/6: waiting for board status notification with ${TR_MARKET_PRICES_CARD_ID} running`);
        const runningStatus = await waitForSseCardStatus(
          TR_MARKET_PRICES_CARD_ID,
          'running',
          statusHistoryStart,
          30_000,
          `TR SSE running status for ${TR_MARKET_PRICES_CARD_ID}`,
        );
        assert(
          runningStatus.card && String(runningStatus.card.status || '') === 'running',
          `TR expected ${TR_MARKET_PRICES_CARD_ID} running in SSE status: ${jsonText(runningStatus.statusData)}`,
        );

        console.log(`[${formatTestId('TR')}] step 6/6: waiting for board status notification with ${TR_MARKET_PRICES_CARD_ID} completed`);
        const completedStatus = await waitForSseCardStatus(
          TR_MARKET_PRICES_CARD_ID,
          'completed',
          statusHistoryStart,
          30_000,
          `TR SSE completed status for ${TR_MARKET_PRICES_CARD_ID}`,
        );
        assert(
          completedStatus.card && String(completedStatus.card.status || '') === 'completed',
          `TR expected ${TR_MARKET_PRICES_CARD_ID} completed in SSE status after refresh: ${jsonText(completedStatus.statusData)}`,
        );

        console.log(`[${formatTestId('TR')}] card refresh lifecycle verified for ${TR_MARKET_PRICES_CARD_ID}`);
      } finally {
        if (trSseConnected) {
          await closeBoardSseConnection({ clearChatEvents: true });
        }
      }
    }

    console.log('\n=== Selected tests passed ===\n');
  } finally {
    if (chatSseClientId) {
      try {
        expectMcpSuccess(
          await callControlplaneMcp('sse.unsubscribe-chat', {
            card_id: PORTFOLIO_CARD_ID,
            client_id: chatSseClientId,
          }),
          `sse.unsubscribe-chat ${PORTFOLIO_CARD_ID}`,
        );
      } catch {
        // Best-effort unsubscribe for test client.
      }
    }
    await closeBoardSseConnection();
    for (const cardId of [...new Set(createdCardIds)].reverse()) {
      try {
        const removeResult = await callMcp('manage.remove-card', { card_id: cardId });
        if (removeResult.status === 200 && removeResult.data?.status === 'success') {
          console.log(`[cleanup] removed ${cardId}`);
        } else {
          console.error(`[cleanup] remove-card failed for ${cardId}: ${jsonText(removeResult.data)}`);
        }
      } catch (error) {
        console.error(`[cleanup] remove-card errored for ${cardId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const deprecateResult = await httpJson('POST', manageBoardsUrl, {
        subcommand: 'deprecate-board',
        args: { boardId: BOARD_ID },
      });
      if (deprecateResult.status === 200 && deprecateResult.data?.status === 'success') {
        console.log(`[cleanup] deprecated board ${BOARD_ID} -> ${jsonText(deprecateResult.data?.data || {})}`);
      } else {
        console.error(`[cleanup] deprecate-board failed for ${BOARD_ID}: ${jsonText(deprecateResult.data)}`);
      }
    } catch (error) {
      console.error(`[cleanup] deprecate-board errored for ${BOARD_ID}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cleanupHostedRuntimeContext();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
