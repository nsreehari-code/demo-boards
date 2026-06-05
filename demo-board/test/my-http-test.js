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
  if (normalized === 'firebase') return 'firebase';
  throw new Error(`Unsupported --mode '${rawValue}'. Use 'localfs' or 'firebase'.`);
}

function defaultHostedConfigPathForMode(mode) {
  if (mode === 'firebase') {
    return path.resolve(__dirname, '../server/hosted-board-runtime/hosted-board-runtime.config.json');
  }
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
      await dynamicBoards.ensureSeeded();
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

const BOARD_ID = cliBoardId || 'live-test';
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

async function main() {
  const { hostConfig } = await getHostedRuntimeContext();
  const modePrefix = hostConfig.storageAdapter === 'localfs' ? 'L' : 'F';
  const modeLabel = hostConfig.storageAdapter === 'localfs' ? 'localfs' : 'firebase';
  const formatTestId = (testId) => `${modePrefix}-${String(testId || '').trim().toUpperCase()}`;
  const printedTests = requestedTests
    ? Array.from(requestedTests).map((testId) => formatTestId(testId)).join(',')
    : ['MB1', 'T0', 'T1', 'TQ', 'TT', 'T2', 'T3', 'T4', 'TS', 'T8', 'T9', 'T8F', 'T9F'].map((testId) => formatTestId(testId)).join(',');

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
    console.log(`[${formatTestId('MB1')}] board '${BOARD_ID}' already registered; calling refresh-board`);
    const refreshResult = await httpJson('POST', manageBoardsUrl, {
      subcommand: 'refresh-board',
      args: {
        boardId: BOARD_ID,
      },
    });
    assert(
      refreshResult.status === 200 && refreshResult.data?.status === 'success',
      `${formatTestId('MB1')} refresh-board failed: HTTP ${refreshResult.status} ${jsonText(refreshResult.data)}`,
    );
    console.log(`[${formatTestId('MB1')}] refresh-board succeeded for '${BOARD_ID}'`);
  }

  const createdCardIds = [];
  const sseState = {
    initialPayload: null,
    latestPayload: null,
    latestStatusData: null,
    statusSummary: null,
    chatEvents: [],
  };
  let chatSseWorker = null;
  let chatSseClientId = '';
  const callMcp = (tool, args) => httpJson('POST', `${API_BASE}/mcp`, { tool, args });
  const callControlplaneMcp = (tool, args) => httpJson('POST', `${API_BASE}/mcp-controlplane`, {
    tool,
    args: { board_id: BOARD_ID, ...args },
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
      if (notification?.kind !== 'card_chats' || notification.cardId !== cardId) continue;
      const messages = Array.isArray(notification.messages) ? notification.messages : [];
      sseState.chatEvents.push({
        at: Date.now(),
        cardId: notification.cardId,
        processing: !!notification.processing,
        receiving: !!notification.receiving,
        messageCount: messages.length,
        messages,
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

  function applySseFrame(payload, cardId) {
    if (payload && Array.isArray(payload.cardDefinitions)) {
      if (!sseState.initialPayload && payload.cardDefinitions.length > 0) {
        sseState.initialPayload = payload;
      }
      sseState.latestPayload = payload;
    }

    const statusData = extractStatusDataFromSsePayload(payload);
    if (statusData) {
      sseState.latestStatusData = statusData;
      if (statusData.summary) {
        sseState.statusSummary = statusData.summary;
      }
    }

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
      if (!bouquet.processingDoneSeen || bouquet.assistantMessages.length === 0) {
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
      const statusData = sseState.latestStatusData;
      const card = findBoardStatusCard(statusData, cardId);
      return card && String(card.status || '') === 'completed'
        ? { statusData, card }
        : false;
    }, timeoutMs, label);
  }

  async function waitForSseSummary(timeoutMs, label) {
    return await waitUntil(() => {
      const summary = sseState.statusSummary;
      return summary ? summary : false;
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
      console.log(`\n=== ${formatTestId('T3')}: probe chat send + inspect + controlplane processing ===`);

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
      console.log(`\n=== ${formatTestId('T4')}: probe chat with attachment + poll lifecycle ===`);

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
      console.log(`\n=== ${formatTestId('TS')}: probe chat with attachment + SSE lifecycle ===`);

      console.log(`[${formatTestId('TS')}] step 0/11: upserting ${PORTFOLIO_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioSeedCard,
        }),
        'TS manage.upsert-card portfolio',
      );
      createdCardIds.push(PORTFOLIO_CARD_ID);
      let tsChatSubscribed = false;
      try {
        console.log(`[${formatTestId('TS')}] step 1/11: subscribing chat SSE for ${PORTFOLIO_CARD_ID}`);
        await closeBoardSseConnection({ clearChatEvents: true });
        await ensureChatSseSubscription(PORTFOLIO_CARD_ID);
        tsChatSubscribed = true;

        console.log(`[${formatTestId('TS')}] step 2/11: waiting for live /sse bootstrap payload`);
        await waitUntil(
          () => sseState.initialPayload || false,
          15_000,
          `TS initial /sse payload for ${PORTFOLIO_CARD_ID}`,
        );
        const bootstrapSummary = await waitForSseSummary(15_000, `TS SSE summary for ${PORTFOLIO_CARD_ID}`);
        assert(bootstrapSummary, `TS live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);

        console.log(`[${formatTestId('TS')}] step 2.1/11: waiting for ${PORTFOLIO_CARD_ID} to appear completed in SSE status`);
        const completedStatus = await waitForSseCompletedCard(PORTFOLIO_CARD_ID, 15_000, `TS SSE completed status for ${PORTFOLIO_CARD_ID}`);
        const bootstrapCard = completedStatus.card;
        assert(bootstrapSummary, `TS live /sse summary missing after status wait: ${jsonText(completedStatus.statusData)}`);
        assert(Number(bootstrapSummary.completed || 0) >= 1, `TS expected completed count >= 1 after upsert: ${jsonText(bootstrapSummary)}`);
        assert(bootstrapCard && String(bootstrapCard.status || '') === 'completed', `TS expected ${PORTFOLIO_CARD_ID} completed in SSE built state: ${jsonText(completedStatus.statusData)}`);

        const turnId = `ts${makeTurnId()}`;
        const promptText = 'what is the content in the attached file';
        const probeText = buildProbeChatText(promptText, 'echoattach');
        const expectedProbeReply = 'what is the capital of japan';

        console.log(`[${formatTestId('TS')}] step 3/11: adding chat attachment for turn ${turnId}`);
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

        console.log(`[${formatTestId('TS')}] step 4/11: sending probe chat turn ${turnId} with attachment`);
        expectMcpSuccess(
          await callAction('chat-send', PORTFOLIO_CARD_ID, {
            text: probeText,
            probe: 'echoattach',
            'turn-id': turnId,
          }),
          'TS chat-send',
        );

        console.log(`[${formatTestId('TS')}] step 5/11: waiting for SSE processing-done notification`);
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

        console.log(`[${formatTestId('TS')}] step 6/11: verifying notification bouquet contents`);
        const expectedProbeReplyPattern = new RegExp(expectedProbeReply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        assert(bouquet.processingOnSeen, `TS bouquet missing processing-on notification for turn ${turnId}`);
        assert(bouquet.processingDoneSeen, `TS bouquet missing processing-done notification for turn ${turnId}`);
        const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
        assert(bouquetUserMessage, `TS bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAttachmentSystemMessage = bouquet.systemMessages.find((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(bouquetAttachmentSystemMessage, `TS bouquet missing attachment system message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => expectedProbeReplyPattern.test(String(message?.text || '')));
        assert(bouquetAssistantMessage, `TS bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

        console.log(`[${formatTestId('TS')}] step 7/11: verifying persisted turn contents`);
        const finalMessages = await readChatMessages(PORTFOLIO_CARD_ID, turnId);
        const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
        const finalAssistantMessage = finalMessages.find((message) => message?.role === 'assistant');
        assert(finalUserMessage, `TS final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(finalAssistantMessage, `TS final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(String(finalUserMessage.text || '') === promptText, `TS final user text mismatch: ${jsonText(finalUserMessage)}`);
        const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(turnSystemMessage, `TS turn missing system attachment message: ${jsonText(finalMessages)}`);
        assert(String(finalAssistantMessage.text || '').includes(expectedProbeReply), `TS final probe reply text mismatch: ${jsonText(finalAssistantMessage)}`);

        console.log(`[${formatTestId('TS')}] step 8/11: final probe reply with attachment contents passed`);
        console.log(`[${formatTestId('TS')}] final probe reply: ${String(finalAssistantMessage.text || '')}`);
      } finally {
        if (tsChatSubscribed) {
          console.log(`[${formatTestId('TS')}] step 9/11: unsubscribing chat SSE for ${PORTFOLIO_CARD_ID}`);
          try {
            await unsubscribeChatSseSubscription(PORTFOLIO_CARD_ID);
          } catch (err) {
            console.warn(`[${formatTestId('TS')}] chat SSE unsubscribe failed: ${String(err?.message || err)}`);
          }
        }
      }
    }

    if (isTestSelected(requestedTests, 'T8')) {
      console.log(`\n=== ${formatTestId('T8')}: real assistant chat over hosted SSE ===`);

      console.log(`[${formatTestId('T8')}] step 0/8: upserting ${T8_CHAT_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: T8_CHAT_CARD_ID,
          candidate_card_content: t8ChatSeedCard,
        }),
        'T8 manage.upsert-card portfolio',
      );
      createdCardIds.push(T8_CHAT_CARD_ID);

      console.log(`[${formatTestId('T8')}] step 1/8: waiting for live /sse bootstrap payload`);
      await closeBoardSseConnection({ clearChatEvents: true });
      await ensureChatSseSubscription(T8_CHAT_CARD_ID);
      await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `T8 initial /sse payload for ${T8_CHAT_CARD_ID}`,
      );
      const bootstrapSummary = await waitForSseSummary(15_000, `T8 SSE summary for ${T8_CHAT_CARD_ID}`);
      assert(bootstrapSummary, `T8 live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);

      const turnId = `t8copilot_${makeTurnId()}`;
      const promptText = 'Just answer what is the capital of France. No fluff. No commentary. No markup. Respond in lower case in one word.';
      const markedPromptText = buildProbeChatText(promptText, 'copilot');
      const eventStart = sseState.chatEvents.length;

      console.log(`[${formatTestId('T8')}] step 2/8: sending real-assistant chat turn ${turnId}`);
      expectMcpSuccess(
        await callAction('chat-send', T8_CHAT_CARD_ID, {
          text: markedPromptText,
          'turn-id': turnId,
        }),
        'T8 chat-send',
      );

      console.log(`[${formatTestId('T8')}] step 3/8: verifying user chat entry is stored`);
      const userMessagesPoll = await pollChatMessages(
        T8_CHAT_CARD_ID,
        turnId,
        5,
        500,
        (messages) => messages.some((message) => message?.role === 'user' && String(message?.text || '') === promptText),
        `user chat message for turn ${turnId}`,
      );
      assert(userMessagesPoll.matched, `T8 user message not found for turn ${turnId}: ${jsonText(userMessagesPoll.messages)}`);
      console.log(`[${formatTestId('T8')}] user chat entry stored in ${userMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T8')}] step 4/8: waiting for SSE processing-done notification`);
      const bouquet = await waitForChatTurnBouquet({
        eventStart,
        turnId,
        timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
        label: `T8 chat turn bouquet for turn ${turnId}`,
      });

      console.log(`[${formatTestId('T8')}] step 5/8: verifying notification bouquet contents`);
      assert(bouquet.processingOnSeen, `T8 bouquet missing processing-on notification for turn ${turnId}`);
      assert(bouquet.processingDoneSeen, `T8 bouquet missing processing-done notification for turn ${turnId}`);
      const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
      assert(bouquetUserMessage, `T8 bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
      const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => /paris/i.test(String(message?.text || '')));
      assert(bouquetAssistantMessage, `T8 bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

      console.log(`[${formatTestId('T8')}] step 6/8: verifying final inspected messages`);
  const finalMessages = await readChatMessages(T8_CHAT_CARD_ID, turnId);
      const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
      const finalAssistantMessage = [...finalMessages].reverse().find((message) => message?.role === 'assistant');
      assert(finalUserMessage, `T8 final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(finalAssistantMessage, `T8 final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(String(finalUserMessage.text || '') === promptText, `T8 final user text mismatch: ${jsonText(finalUserMessage)}`);
      assert(/paris/i.test(String(finalAssistantMessage.text || '')), `T8 final assistant text mismatch: ${jsonText(finalAssistantMessage)}`);
      console.log(`[${formatTestId('T8')}] final assistant reply: ${String(finalAssistantMessage.text || '')}`);

      console.log(`[${formatTestId('T8')}] step 7/8: verifying live /sse board-state bootstrap`);
      resetBoardSseState();
      await ensureBoardSseConnection(T8_CHAT_CARD_ID);
      await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `T8 final /sse payload for ${T8_CHAT_CARD_ID}`,
      );
      const finalBootstrapSummary = await waitForSseSummary(15_000, `T8 final SSE summary for ${T8_CHAT_CARD_ID}`);
      const finalBootstrapCompletedStatus = await waitForSseCompletedCard(T8_CHAT_CARD_ID, 15_000, `T8 SSE completed status for ${T8_CHAT_CARD_ID}`);
      const finalBootstrapCard = finalBootstrapCompletedStatus.card;
      assert(finalBootstrapSummary, `T8 final live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);
      assert(finalBootstrapCard && String(finalBootstrapCard.status || '') === 'completed', `T8 expected ${T8_CHAT_CARD_ID} completed in final SSE built state: ${jsonText(finalBootstrapCompletedStatus.statusData)}`);
      await closeBoardSseConnection({ clearChatEvents: true });
    }

    if (isTestSelected(requestedTests, 'T9')) {
      console.log(`\n=== ${formatTestId('T9')}: foundry-forced assistant chat over hosted SSE ===`);

      console.log(`[${formatTestId('T9')}] step 0/8: upserting ${T9_CHAT_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: T9_CHAT_CARD_ID,
          candidate_card_content: t9ChatSeedCard,
        }),
        'T9 manage.upsert-card portfolio',
      );
      createdCardIds.push(T9_CHAT_CARD_ID);

      console.log(`[${formatTestId('T9')}] step 1/8: waiting for live /sse bootstrap payload`);
      await closeBoardSseConnection({ clearChatEvents: true });
      await ensureChatSseSubscription(T9_CHAT_CARD_ID);
      await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `T9 initial /sse payload for ${T9_CHAT_CARD_ID}`,
      );
      const bootstrapSummary = await waitForSseSummary(15_000, `T9 SSE summary for ${T9_CHAT_CARD_ID}`);
      assert(bootstrapSummary, `T9 live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);

      const turnId = `t9foundry_${makeTurnId()}`;
      const promptText = 'Just answer what is the capital of France. No fluff. No commentary. No markup. Respond in lower case in one word.';
      const markedPromptText = buildProbeChatText(promptText, 'foundry');
      const eventStart = sseState.chatEvents.length;

      console.log(`[${formatTestId('T9')}] step 2/8: sending foundry-forced chat turn ${turnId}`);
      expectMcpSuccess(
        await callAction('chat-send', T9_CHAT_CARD_ID, {
          text: markedPromptText,
          'turn-id': turnId,
        }),
        'T9 chat-send',
      );

      console.log(`[${formatTestId('T9')}] step 3/8: verifying user chat entry is stored`);
      const userMessagesPoll = await pollChatMessages(
        T9_CHAT_CARD_ID,
        turnId,
        5,
        500,
        (messages) => messages.some((message) => message?.role === 'user' && String(message?.text || '') === promptText),
        `user chat message for turn ${turnId}`,
      );
      assert(userMessagesPoll.matched, `T9 user message not found for turn ${turnId}: ${jsonText(userMessagesPoll.messages)}`);
      console.log(`[${formatTestId('T9')}] user chat entry stored in ${userMessagesPoll.attemptsUsed} poll(s)`);

      console.log(`[${formatTestId('T9')}] step 4/8: waiting for SSE processing-done notification`);
      const bouquet = await waitForChatTurnBouquet({
        eventStart,
        turnId,
        timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
        label: `T9 chat turn bouquet for turn ${turnId}`,
      });

      console.log(`[${formatTestId('T9')}] step 5/8: verifying notification bouquet contents`);
      assert(bouquet.processingOnSeen, `T9 bouquet missing processing-on notification for turn ${turnId}`);
      assert(bouquet.processingDoneSeen, `T9 bouquet missing processing-done notification for turn ${turnId}`);
      const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
      assert(bouquetUserMessage, `T9 bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
      const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => /paris/i.test(String(message?.text || '')));
      assert(bouquetAssistantMessage, `T9 bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

      console.log(`[${formatTestId('T9')}] step 6/8: verifying final inspected messages`);
      const finalMessages = await readChatMessages(T9_CHAT_CARD_ID, turnId);
      const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
      const finalAssistantMessage = [...finalMessages].reverse().find((message) => message?.role === 'assistant');
      assert(finalUserMessage, `T9 final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(finalAssistantMessage, `T9 final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
      assert(String(finalUserMessage.text || '') === promptText, `T9 final user text mismatch: ${jsonText(finalUserMessage)}`);
      assert(/paris/i.test(String(finalAssistantMessage.text || '')), `T9 final assistant text mismatch: ${jsonText(finalAssistantMessage)}`);
      console.log(`[${formatTestId('T9')}] final assistant reply: ${String(finalAssistantMessage.text || '')}`);

      console.log(`[${formatTestId('T9')}] step 7/8: verifying live /sse board-state bootstrap`);
      resetBoardSseState();
      await ensureBoardSseConnection(T9_CHAT_CARD_ID);
      await waitUntil(
        () => sseState.initialPayload || false,
        15_000,
        `T9 final /sse payload for ${T9_CHAT_CARD_ID}`,
      );
      const finalBootstrapSummary = await waitForSseSummary(15_000, `T9 final SSE summary for ${T9_CHAT_CARD_ID}`);
      const finalBootstrapCompletedStatus = await waitForSseCompletedCard(T9_CHAT_CARD_ID, 15_000, `T9 SSE completed status for ${T9_CHAT_CARD_ID}`);
      const finalBootstrapCard = finalBootstrapCompletedStatus.card;
      assert(finalBootstrapSummary, `T9 final live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);
      assert(finalBootstrapCard && String(finalBootstrapCard.status || '') === 'completed', `T9 expected ${T9_CHAT_CARD_ID} completed in final SSE built state: ${jsonText(finalBootstrapCompletedStatus.statusData)}`);
      await closeBoardSseConnection({ clearChatEvents: true });
    }

    if (isTestSelected(requestedTests, 'T8F')) {
      console.log(`\n=== ${formatTestId('T8F')}: real assistant attachment chat over hosted SSE ===`);

      console.log(`[${formatTestId('T8F')}] step 0/11: upserting ${T8F_CHAT_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: T8F_CHAT_CARD_ID,
          candidate_card_content: t8fChatSeedCard,
        }),
        'T8F manage.upsert-card portfolio',
      );
      createdCardIds.push(T8F_CHAT_CARD_ID);
      let t8fChatSubscribed = false;
      try {
        console.log(`[${formatTestId('T8F')}] step 1/11: subscribing chat SSE for ${T8F_CHAT_CARD_ID}`);
        await closeBoardSseConnection({ clearChatEvents: true });
        await ensureChatSseSubscription(T8F_CHAT_CARD_ID);
        t8fChatSubscribed = true;

        console.log(`[${formatTestId('T8F')}] step 2/11: waiting for live /sse bootstrap payload`);
        await waitUntil(
          () => sseState.initialPayload || false,
          15_000,
          `T8F initial /sse payload for ${T8F_CHAT_CARD_ID}`,
        );
        const bootstrapSummary = await waitForSseSummary(15_000, `T8F SSE summary for ${T8F_CHAT_CARD_ID}`);
        assert(bootstrapSummary, `T8F live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);


        const turnId = `t8f${makeTurnId()}`;
        const promptText = 'Answer the question in attached file in one word lower case.';
        const markedPromptText = buildProbeChatText(promptText, 'copilot');
        const expectedAssistantReply = 'tokyo';

        console.log(`[${formatTestId('T8F')}] step 3/11: adding chat attachment for turn ${turnId}`);
        const uploadResult = expectMcpSuccess(
          await callControlplaneMcp('manage.add-chat-attachment', {
            card_id: T8F_CHAT_CARD_ID,
            turn_id: turnId,
            file_name: 't8f-question.txt',
            content_type: 'text/plain; charset=utf-8',
            text: 'What is the capital of Japan',
          }),
          'T8F manage.add-chat-attachment',
        );
        const uploadedFile = Array.isArray(uploadResult?.files) ? uploadResult.files[0] : null;
        assert(uploadedFile && typeof uploadedFile === 'object', 'T8F upload response missing file metadata');
        assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), 'T8F uploaded file metadata should not expose path');

        const cardAfterUpload = readStoredCard(
          expectMcpSuccess(
            await callMcp('manage.read-card', { card_id: T8F_CHAT_CARD_ID }),
            'T8F manage.read-card after upload',
          ),
        );
        const storedFiles = Array.isArray(cardAfterUpload?.card_data?.files) ? cardAfterUpload.card_data.files : [];
        const storedFile = storedFiles.find((file) => String(file?.stored_name || '') === String(uploadedFile?.stored_name || ''));
        assert(!!storedFile, 'T8F stored file metadata missing after upload');
        assert(storedFile?.chat === true, 'T8F stored file should be marked as chat-origin');
        assert(!Object.prototype.hasOwnProperty.call(storedFile || {}, 'path'), 'T8F stored file metadata should not expose path');

        const afterUploadMessages = await readChatMessages(T8F_CHAT_CARD_ID, turnId);
        const uploadSystemMessage = afterUploadMessages.find((message) => message?.role === 'system');
        assert(!!uploadSystemMessage, 'T8F upload protocol missing system chat message');
        assert(String(uploadSystemMessage?.text || '').toLowerCase().includes('file uploaded:'), 'T8F upload system message does not describe uploaded file');

        const eventStart = sseState.chatEvents.length;

        console.log(`[${formatTestId('T8F')}] step 4/11: sending real-assistant chat turn ${turnId} with attachment`);
        expectMcpSuccess(
          await callAction('chat-send', T8F_CHAT_CARD_ID, {
            text: markedPromptText,
            'turn-id': turnId,
          }),
          'T8F chat-send',
        );

        console.log(`[${formatTestId('T8F')}] step 5/11: waiting for SSE processing-done notification`);
        const bouquet = await waitForChatTurnState({
          eventStart,
          turnId,
          timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
          label: `T8F chat turn bouquet for turn ${turnId}`,
          predicate: (currentBouquet) => {
            const hasUser = currentBouquet.userMessages.some((message) => String(message?.text || '') === promptText);
            const hasSystem = currentBouquet.systemMessages.some((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
            const hasAssistant = currentBouquet.assistantMessages.some((message) => /tokyo/i.test(String(message?.text || '')));
            return currentBouquet.processingOnSeen && currentBouquet.processingDoneSeen && hasUser && hasSystem && hasAssistant;
          },
        });

        console.log(`[${formatTestId('T8F')}] step 6/11: verifying notification bouquet contents`);
        assert(bouquet.processingOnSeen, `T8F bouquet missing processing-on notification for turn ${turnId}`);
        assert(bouquet.processingDoneSeen, `T8F bouquet missing processing-done notification for turn ${turnId}`);
        const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
        assert(bouquetUserMessage, `T8F bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAttachmentSystemMessage = bouquet.systemMessages.find((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(bouquetAttachmentSystemMessage, `T8F bouquet missing attachment system message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => /tokyo/i.test(String(message?.text || '')));
        assert(bouquetAssistantMessage, `T8F bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

        console.log(`[${formatTestId('T8F')}] step 7/11: verifying persisted turn contents`);
        const finalMessages = await readChatMessages(T8F_CHAT_CARD_ID, turnId);
        const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
        const finalAssistantMessage = [...finalMessages].reverse().find((message) => message?.role === 'assistant');
        assert(finalUserMessage, `T8F final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(finalAssistantMessage, `T8F final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(String(finalUserMessage.text || '') === promptText, `T8F final user text mismatch: ${jsonText(finalUserMessage)}`);
        const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(turnSystemMessage, `T8F turn missing system attachment message: ${jsonText(finalMessages)}`);
        assert(/^tokyo\b/i.test(String(finalAssistantMessage.text || '').trim()), `T8F final assistant text mismatch: ${jsonText(finalAssistantMessage)}`);

        console.log(`[${formatTestId('T8F')}] step 8/11: final assistant reply with attachment contents passed`);
        console.log(`[${formatTestId('T8F')}] final assistant reply: ${String(finalAssistantMessage.text || '')}`);
      } finally {
        if (t8fChatSubscribed) {
          console.log(`[${formatTestId('T8F')}] step 9/11: unsubscribing chat SSE for ${T8F_CHAT_CARD_ID}`);
          try {
            await unsubscribeChatSseSubscription(T8F_CHAT_CARD_ID);
          } catch (err) {
            console.warn(`[${formatTestId('T8F')}] chat SSE unsubscribe failed: ${String(err?.message || err)}`);
          }
        }
      }
    }

    if (isTestSelected(requestedTests, 'T9F')) {
      console.log(`\n=== ${formatTestId('T9F')}: foundry-forced attachment chat over hosted SSE ===`);

      console.log(`[${formatTestId('T9F')}] step 0/11: upserting ${T9F_CHAT_CARD_ID} for chat`);
      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: T9F_CHAT_CARD_ID,
          candidate_card_content: t9fChatSeedCard,
        }),
        'T9F manage.upsert-card portfolio',
      );
      createdCardIds.push(T9F_CHAT_CARD_ID);
      let t9fChatSubscribed = false;
      try {
        console.log(`[${formatTestId('T9F')}] step 1/11: subscribing chat SSE for ${T9F_CHAT_CARD_ID}`);
        await closeBoardSseConnection({ clearChatEvents: true });
        await ensureChatSseSubscription(T9F_CHAT_CARD_ID);
        t9fChatSubscribed = true;

        console.log(`[${formatTestId('T9F')}] step 2/11: waiting for live /sse bootstrap payload`);
        await waitUntil(
          () => sseState.initialPayload || false,
          15_000,
          `T9F initial /sse payload for ${T9F_CHAT_CARD_ID}`,
        );
        const bootstrapSummary = await waitForSseSummary(15_000, `T9F SSE summary for ${T9F_CHAT_CARD_ID}`);
        assert(bootstrapSummary, `T9F live /sse summary missing: ${jsonText(sseState.latestStatusData || sseState.latestPayload || sseState.initialPayload)}`);


        const turnId = `t9f${makeTurnId()}`;
        const promptText = 'Answer the matheamtical question in the attached file.  Only the final numerical answer in digits please';
        const markedPromptText = buildProbeChatText(promptText, 'foundry');

        console.log(`[${formatTestId('T9F')}] step 3/11: adding chat attachment for turn ${turnId}`);
        const uploadResult = expectMcpSuccess(
          await callControlplaneMcp('manage.add-chat-attachment', {
            card_id: T9F_CHAT_CARD_ID,
            turn_id: turnId,
            file_name: 't9f-question.txt',
            content_type: 'text/plain; charset=utf-8',
            text: 'What is two plus three plus four?',
          }),
          'T9F manage.add-chat-attachment',
        );
        const uploadedFile = Array.isArray(uploadResult?.files) ? uploadResult.files[0] : null;
        assert(uploadedFile && typeof uploadedFile === 'object', 'T9F upload response missing file metadata');
        assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), 'T9F uploaded file metadata should not expose path');

        const cardAfterUpload = readStoredCard(
          expectMcpSuccess(
            await callMcp('manage.read-card', { card_id: T9F_CHAT_CARD_ID }),
            'T9F manage.read-card after upload',
          ),
        );
        const storedFiles = Array.isArray(cardAfterUpload?.card_data?.files) ? cardAfterUpload.card_data.files : [];
        const storedFile = storedFiles.find((file) => String(file?.stored_name || '') === String(uploadedFile?.stored_name || ''));
        assert(!!storedFile, 'T9F stored file metadata missing after upload');
        assert(storedFile?.chat === true, 'T9F stored file should be marked as chat-origin');
        assert(!Object.prototype.hasOwnProperty.call(storedFile || {}, 'path'), 'T9F stored file metadata should not expose path');

        const afterUploadMessages = await readChatMessages(T9F_CHAT_CARD_ID, turnId);
        const uploadSystemMessage = afterUploadMessages.find((message) => message?.role === 'system');
        assert(!!uploadSystemMessage, 'T9F upload protocol missing system chat message');
        assert(String(uploadSystemMessage?.text || '').toLowerCase().includes('file uploaded:'), 'T9F upload system message does not describe uploaded file');

        const eventStart = sseState.chatEvents.length;

        console.log(`[${formatTestId('T9F')}] step 4/11: sending foundry-forced chat turn ${turnId} with attachment`);
        expectMcpSuccess(
          await callAction('chat-send', T9F_CHAT_CARD_ID, {
            text: markedPromptText,
            'turn-id': turnId,
          }),
          'T9F chat-send',
        );

        console.log(`[${formatTestId('T9F')}] step 5/11: waiting for SSE processing-done notification`);
        const bouquet = await waitForChatTurnState({
          eventStart,
          turnId,
          timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
          label: `T9F chat turn bouquet for turn ${turnId}`,
          predicate: (currentBouquet) => {
            const hasUser = currentBouquet.userMessages.some((message) => String(message?.text || '') === promptText);
            const hasSystem = currentBouquet.systemMessages.some((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
            const hasAssistant = currentBouquet.assistantMessages.some((message) => /(?:^|\b)9(?:\b|$)/.test(String(message?.text || '')));
            return currentBouquet.processingOnSeen && currentBouquet.processingDoneSeen && hasUser && hasSystem && hasAssistant;
          },
        });

        console.log(`[${formatTestId('T9F')}] step 6/11: verifying notification bouquet contents`);
        assert(bouquet.processingOnSeen, `T9F bouquet missing processing-on notification for turn ${turnId}`);
        assert(bouquet.processingDoneSeen, `T9F bouquet missing processing-done notification for turn ${turnId}`);
        const bouquetUserMessage = bouquet.userMessages.find((message) => String(message?.text || '') === promptText);
        assert(bouquetUserMessage, `T9F bouquet missing user message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAttachmentSystemMessage = bouquet.systemMessages.find((message) => String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(bouquetAttachmentSystemMessage, `T9F bouquet missing attachment system message for turn ${turnId}: ${jsonText(bouquet.messages)}`);
        const bouquetAssistantMessage = bouquet.assistantMessages.find((message) => /(?:^|\b)9(?:\b|$)/.test(String(message?.text || '')));
        assert(bouquetAssistantMessage, `T9F bouquet assistant reply missing or invalid for turn ${turnId}: ${jsonText(bouquet.messages)}`);

        console.log(`[${formatTestId('T9F')}] step 7/11: verifying persisted turn contents`);
        const finalMessages = await readChatMessages(T9F_CHAT_CARD_ID, turnId);
        const finalUserMessage = finalMessages.find((message) => message?.role === 'user');
        const finalAssistantMessage = [...finalMessages].reverse().find((message) => message?.role === 'assistant');
        assert(finalUserMessage, `T9F final user message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(finalAssistantMessage, `T9F final assistant message missing for turn ${turnId}: ${jsonText(finalMessages)}`);
        assert(String(finalUserMessage.text || '') === promptText, `T9F final user text mismatch: ${jsonText(finalUserMessage)}`);
        const turnSystemMessage = finalMessages.find((message) => message?.role === 'system' && String(message?.text || '').toLowerCase().includes('file uploaded:'));
        assert(turnSystemMessage, `T9F turn missing system attachment message: ${jsonText(finalMessages)}`);
        assert(/^9\b/.test(String(finalAssistantMessage.text || '').trim()), `T9F final assistant text mismatch: ${jsonText(finalAssistantMessage)}`);

        console.log(`[${formatTestId('T9F')}] step 8/11: final assistant reply with attachment contents passed`);
        console.log(`[${formatTestId('T9F')}] final assistant reply: ${String(finalAssistantMessage.text || '')}`);
      } finally {
        if (t9fChatSubscribed) {
          console.log(`[${formatTestId('T9F')}] step 9/11: unsubscribing chat SSE for ${T9F_CHAT_CARD_ID}`);
          try {
            await unsubscribeChatSseSubscription(T9F_CHAT_CARD_ID);
          } catch (err) {
            console.warn(`[${formatTestId('T9F')}] chat SSE unsubscribe failed: ${String(err?.message || err)}`);
          }
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
