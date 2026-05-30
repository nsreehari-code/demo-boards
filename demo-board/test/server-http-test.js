#!/usr/bin/env node
/**
 * demo-http-test.js
 *
 * Smoke test for demo-board/server/board-server.js over HTTP + SSE.
 * Targets a named board on the configured board server.
 *
 * Prerequisites:
 *   - Board server running at port 7799 (or --port override)
 *   - MCP server running at port 7801 (or DEMO_BOARDS_MCP_SERVER_URL override)
 *   The test attaches to the running servers — it does NOT spawn its own.
 *
 * T0: cleanup → bootstrap/init → SSE initial payload → wait for all cards to complete
 * T1: PATCH holdings (+1 row) → verify recomputation (holdings +1, positions +1)
 *
 * Usage:
 *   node test/server-http-test.js [--board-id live-test] [--port 7799] [--run-tests T1,T2]
 */

import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

const COPILOT_OUTPUT_CHANNEL = 'copilot-output';

const ECHO_PROBE_MARKER = '__probe__echo__probe__';
const PROBE_IN_PROGRESS_TEXT = 'in-progress';
const PROBE_WATCHPARTY_FRAME_1 = 'probe frame 1';
const PROBE_WATCHPARTY_FRAME_2 = 'probe frame 2';
const NON_PROBE_RESPONSE_TIMEOUT_MS = 120_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
function readCliOptionValue(args, optionName) {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex === -1) return '';
  return String(args[optionIndex + 1] || '').trim();
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

const requestedTests = parseRequestedTests(readCliOptionValue(cliArgs, '--run-tests'));
function isTestSelected(testId) {
  return !requestedTests || requestedTests.has(String(testId || '').trim().toUpperCase());
}

function isAnyTestSelected(testIds) {
  return !requestedTests || testIds.some((testId) => isTestSelected(testId));
}

const portArg = cliArgs.indexOf('--port');
const cliPort = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : NaN;
const boardIdArg = cliArgs.indexOf('--board-id');
const boardAliasArg = cliArgs.indexOf('--board');
const cliBoardId = boardIdArg !== -1
  ? String(cliArgs[boardIdArg + 1] || '').trim()
  : (boardAliasArg !== -1 ? String(cliArgs[boardAliasArg + 1] || '').trim() : '');
const skipT1 = cliArgs.includes('--skip-t1') || !isTestSelected('T1');
const skipT2 = cliArgs.includes('--skip-t2') || !isTestSelected('T2');
const skipT3 = cliArgs.includes('--skip-t3') || !isAnyTestSelected(['T3', 'T3A', 'T3B', 'T3C', 'T3D']);
const forceT3aBypass = process.env.DEMO_T3A_BYPASS === '1';
let __copilotAvailableCache = null;
function isCopilotAvailable() {
  if (__copilotAvailableCache !== null) return __copilotAvailableCache;
  // File-flag cache: once copilot is detected, drop a marker so subsequent runs
  // skip the (slow, cold-start-prone) spawn probe entirely. CI envs that lack
  // copilot can force-skip via DEMO_COPILOT_AVAILABLE=0 or --skip-t3a/--skip-t3c.
  const envOverride = process.env.DEMO_COPILOT_AVAILABLE;
  if (envOverride === '0' || envOverride === 'false') { __copilotAvailableCache = false; return false; }
  if (envOverride === '1' || envOverride === 'true') { __copilotAvailableCache = true; return true; }
  const flagPath = path.join(os.tmpdir(), 'demo-boards-copilot-available.flag');
  try {
    if (fs.existsSync(flagPath)) { __copilotAvailableCache = true; return true; }
  } catch { /* ignore */ }
  try {
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'copilot';
    const args = process.platform === 'win32' ? ['/d', '/c', 'copilot', '--version'] : ['--version'];
    const r = spawnSync(cmd, args, { timeout: 15_000, stdio: 'ignore', windowsHide: true });
    __copilotAvailableCache = !r.error && r.status === 0;
  } catch { __copilotAvailableCache = false; }
  if (__copilotAvailableCache) {
    try { fs.writeFileSync(flagPath, String(Date.now())); } catch { /* ignore */ }
  }
  return __copilotAvailableCache;
}
function require_os() {
  // Lazy synchronous require of node:os without adding a top-level import.
  if (!require_os._mod) {
    const { createRequire } = require_os._cr || (require_os._cr = (() => {
      // eslint-disable-next-line no-shadow
      const u = new URL(import.meta.url);
      return { createRequire: (m => m.createRequire)(/** @type {any} */(globalThis).require ? null : null) };
    })());
    // Fallback: use dynamic import-resolved built-in via process
    require_os._mod = { tmpdir: () => process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp' };
  }
  return require_os._mod;
}

const BOARD_ID = cliBoardId || (process.env.DEMO_BOARD_ID || '').trim() || 'live-test';
const BOARD_DIR = path.resolve(__dirname, '..');
const SERVER_CONFIG_PATH = path.resolve(BOARD_DIR, 'server-config.json');
let __boardChatAssistantCache = null;
function getBoardChatAssistant() {
  if (__boardChatAssistantCache !== null) return __boardChatAssistantCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf-8'));
    __boardChatAssistantCache = String(cfg?.boards?.[BOARD_ID]?.chat?.assistant || 'copilot').toLowerCase();
  } catch { __boardChatAssistantCache = 'copilot'; }
  return __boardChatAssistantCache;
}
function boardRequiresCopilotCli() { return getBoardChatAssistant() === 'copilot'; }

const skipT3a = skipT3 || cliArgs.includes('--skip-t3a') || !isTestSelected('T3A') || (!forceT3aBypass && boardRequiresCopilotCli() && !isCopilotAvailable());
const skipT3b = skipT3 || cliArgs.includes('--skip-t3b') || !isTestSelected('T3B');
const skipT3c = skipT3 || cliArgs.includes('--skip-t3c') || !isTestSelected('T3C') || (boardRequiresCopilotCli() && !isCopilotAvailable());
const skipT3d = skipT3 || cliArgs.includes('--skip-t3d') || !isTestSelected('T3D');
const SSE_WORKER_SCRIPT = path.join(__dirname, 'sse-worker.js');
const BOARD_SERVER_URL = Number.isInteger(cliPort) && cliPort > 0
  ? `http://127.0.0.1:${cliPort}`
  : 'http://127.0.0.1:7799';
const CHAT_CARD_ID = 'card-portfolio';

function loadBoardSetupConfig(boardId) {
  const serverConfig = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf-8'));
  const boardSetup = serverConfig?.boards?.[boardId]?.setup;

  if (!boardSetup || typeof boardSetup !== 'object') {
    throw new Error(`Missing boards.${boardId}.setup in ${SERVER_CONFIG_PATH}`);
  }

  const requiredKeys = [
    'setupRoot',
    'aiWorkspaceRoot',
    'cardStore',
    'artifactsStore',
    'boardRuntime',
    'boardOutputsStore',
    'chatStore',
    'scratchStore',
    'archivalStore',
  ];

  for (const key of requiredKeys) {
    if (typeof boardSetup[key] !== 'string' || !boardSetup[key].trim()) {
      throw new Error(`Expected boards.${boardId}.setup.${key} to be a non-empty string in ${SERVER_CONFIG_PATH}`);
    }
  }

  return boardSetup;
}

const LIVE_TEST_SETUP = loadBoardSetupConfig(BOARD_ID);
const BOARD_SETUP_ROOT = path.resolve(BOARD_DIR, LIVE_TEST_SETUP.setupRoot);
const CLEAN_WORKSPACE_SUBDIRS = [
  LIVE_TEST_SETUP.aiWorkspaceRoot,
  LIVE_TEST_SETUP.cardStore,
  LIVE_TEST_SETUP.artifactsStore,
  LIVE_TEST_SETUP.boardRuntime,
  LIVE_TEST_SETUP.boardOutputsStore,
  LIVE_TEST_SETUP.chatStore,
  LIVE_TEST_SETUP.scratchStore,
  LIVE_TEST_SETUP.archivalStore,
].filter((dir, index, dirs) => dirs.indexOf(dir) === index);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeMcpServer(serverUrl, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const req = http.request(serverUrl, { method: 'OPTIONS', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function emptyDirectoryContents(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
}

function cleanupBoardWorkspaceFiles() {
  if (!/^live-test(?:-|$)/.test(BOARD_ID)) {
    console.log(`[resync] workspace cleanup skipped for board ${BOARD_ID}`);
    return;
  }

  for (const relativeDir of CLEAN_WORKSPACE_SUBDIRS) {
    emptyDirectoryContents(path.join(BOARD_SETUP_ROOT, relativeDir));
  }
  console.log(`[resync] cleaned workspace files under ${BOARD_SETUP_ROOT}`);
}

async function ensureMcpServerRunning(serverUrl) {
  if (await probeMcpServer(serverUrl)) {
    console.log(`[setup] MCP server already available at ${serverUrl}`);
    return;
  }

  throw new Error(`MCP server is down at ${serverUrl}. Start it before running server-http-test.`);
}

function probeBoardServer(timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BOARD_SERVER_URL}/healthz`, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            console.log(`[setup] board server running at ${BOARD_SERVER_URL} (pid=${data.pid}, uptime=${Math.round((data.uptimeMs || 0) / 1000)}s)`);
          } catch { /* ignore parse error */ }
          resolve();
          return;
        }
        reject(new Error(`Board server at ${BOARD_SERVER_URL} returned HTTP ${res.statusCode}. Start it before running server-http-test.`));
      });
    });
    req.on('error', (err) => reject(new Error(`Board server not reachable at ${BOARD_SERVER_URL}: ${err.message}. Start it before running server-http-test.`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Board server at ${BOARD_SERVER_URL} did not respond within ${timeoutMs}ms. Start it before running server-http-test.`));
    });
    req.end();
  });
}

async function cleanupAndInitBoard() {
  cleanupBoardWorkspaceFiles();

  const initResult = await httpGet(`${BOARD_SERVER_URL}/api/boards/${BOARD_ID}/init-board`);
  if (initResult.status !== 200) {
    throw new Error(`init-board returned ${initResult.status}: ${JSON.stringify(initResult.data)}`);
  }
  console.log('[resync] init-board ok');

  return initResult;
}

const PORT = Number(new URL(BOARD_SERVER_URL).port || '80');
const BASE = `${BOARD_SERVER_URL}/api/boards/${BOARD_ID}`;
const MCP_SERVER_URL = (process.env.DEMO_BOARDS_MCP_SERVER_URL || '').trim() || 'http://127.0.0.1:7801/mcp';

// ---------------------------------------------------------------------------
// Shared state — accumulated from SSE frames
// ---------------------------------------------------------------------------

const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
  chatEvents: [],
  watchpartyEvents: [],
};

function applyFrame(payload) {
  if (payload && Array.isArray(payload.cardDefinitions)) {
    if (!NS.initialPayload && payload.cardDefinitions.length > 0) {
      NS.initialPayload = payload;
    }
    const summary = payload.statusSnapshot && payload.statusSnapshot.summary;
    if (summary) {
      NS.statusSummary = summary;
      NS.statusGeneration += 1;
    }
    if (payload.cardRuntimeById) {
      for (const [cardId, runtime] of Object.entries(payload.cardRuntimeById)) {
        if (runtime?.computed_values && Object.keys(runtime.computed_values).length > 0) {
          NS.computedValues[cardId] = runtime.computed_values;
        }
      }
    }
    return;
  }

  if (payload && payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    for (const n of payload.notifications) {
      const summary = n && n.kind === 'status' && n.status && n.status.summary;
      if (summary) {
        NS.statusSummary = summary;
        NS.statusGeneration += 1;
      }
      if (n && n.kind === 'computed_values' && n.cardId) {
        NS.computedValues[n.cardId] = n.values;
      }
    }
  }
}

function normalizeSseChunkBuffer(buf, chunk) {
  return (buf + chunk.replace(/\r\n/g, '\n'));
}

function parseSseBlocks(buffer) {
  const payloads = [];
  let buf = buffer;
  while (true) {
    const idx = buf.indexOf('\n\n');
    if (idx === -1) break;
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const data = dataLines.join('\n');
    if (!data) continue;
    try {
      payloads.push(JSON.parse(data));
    } catch { /* ignore malformed */ }
  }
  return { payloads, remainder: buf };
}

function startSseClient(sseUrl, onPayload) {
  const req = http.get(sseUrl, (res) => {
    let buf = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buf = normalizeSseChunkBuffer(buf, chunk);
      const parsed = parseSseBlocks(buf);
      buf = parsed.remainder;
      for (const payload of parsed.payloads) onPayload(payload);
    });
  });
  req.on('error', () => {});
  return {
    close() {
      try { req.destroy(); } catch { /* */ }
    },
  };
}

function captureChatEvents(payload, cardId) {
  if (!payload || payload.kind !== 'notification-batch' || !Array.isArray(payload.notifications)) return;
  for (const n of payload.notifications) {
    if (n && n.kind === 'card_chats' && n.cardId === cardId) {
      const messages = Array.isArray(n.messages) ? n.messages : [];
      NS.chatEvents.push({
        at: Date.now(),
        cardId: n.cardId,
        processing: !!n.processing,
        receiving: !!n.receiving,
        messageCount: messages.length,
        messages,
      });
    }
  }
}

function captureWatchpartyEvents(payload, cardId, channelName) {
  if (!payload || payload.kind !== 'notification-batch' || !Array.isArray(payload.notifications)) return;
  for (const n of payload.notifications) {
    if (n && n.kind === 'card_watchparty' && n.cardId === cardId && n.channel === channelName) {
      NS.watchpartyEvents.push({
        at: Date.now(),
        cardId: n.cardId,
        channel: n.channel,
        clear: !!n.clear,
        replace: !!n.replace,
        text: String(n?.payload?.text || ''),
      });
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\n[ASSERT FAILED] ${message}`);
    process.exit(1);
  }
}

function randomTurnId() {
  let value = '';
  while (value.length < 6) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, 6);
}

function waitUntil(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      let result;
      try { result = predicate(); } catch { /* retry */ }
      if (result !== undefined && result !== null && result !== false) {
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

const waitForInitialPayload = (ms = 15_000) =>
  waitUntil(() => NS.initialPayload || false, ms, 'initial SSE payload');

const waitForAllCompleted = (ms = 60_000, label = 'all completed') =>
  waitUntil(() => {
    const s = NS.statusSummary;
    if (s && s.card_count > 0 && s.completed === s.card_count) return s;
    return false;
  }, ms, label);

const waitForChatPredicate = (predicate, ms, label) =>
  waitUntil(() => predicate(NS.chatEvents) || false, ms, label);

const waitForWatchpartyPredicate = (predicate, ms, label) =>
  waitUntil(() => predicate(NS.watchpartyEvents) || false, ms, label);

function findAssistantOutcomeInMessages(messages, beforeCount, successPattern, turnId) {
  const newMessages = Array.isArray(messages) ? messages.slice(beforeCount) : [];
  const relevantMessages = turnId
    ? newMessages.filter((message) => String(message?.turn || '') === turnId)
    : newMessages;
  const assistantMessage = [...relevantMessages].reverse().find((message) => message?.role === 'assistant');

  if (assistantMessage) {
    const text = String(assistantMessage.text || '');
    if (successPattern && successPattern.test(text)) {
      return { ok: true, assistantMessage };
    }
    return {
      ok: false,
      reason: `assistant reply did not match expected content: ${text.slice(0, 120) || '(empty)'}`,
      assistantMessage,
    };
  }

  const failureMessage = [...relevantMessages].reverse().find((message) => {
    if (!message || (message.role !== 'system' && message.role !== 'assistant')) return false;
    return /(failed|error|unable to complete|couldn't produce a valid response|intent: failure)/i.test(String(message.text || ''));
  });
  if (failureMessage) {
    return {
      ok: false,
      reason: `chat failure message observed: ${String(failureMessage.text || '').slice(0, 160)}`,
    };
  }

  return null;
}

function findAssistantOutcome(events, options) {
  const successPattern = options?.successPattern instanceof RegExp ? options.successPattern : null;
  const beforeCount = Number.isInteger(options?.beforeCount) && options.beforeCount >= 0 ? options.beforeCount : 0;
  const turnId = typeof options?.turnId === 'string' && options.turnId.trim() ? options.turnId.trim() : '';

  for (const event of events) {
    if (!event || !Array.isArray(event.messages)) continue;

    const messageOutcome = findAssistantOutcomeInMessages(event.messages, beforeCount, successPattern, turnId);
    if (messageOutcome) {
      return { ...messageOutcome, event, source: 'sse' };
    }

  }

  return false;
}
async function waitForAssistantOutcome({ eventStart, beforeCount, successPattern, timeoutMs, label, turnId }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const eventOutcome = findAssistantOutcome(NS.chatEvents.slice(eventStart), {
      beforeCount,
      successPattern,
      turnId,
    });
    if (eventOutcome) {
      return eventOutcome;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`);
}

function findProcessingClearedOutcome(events, { beforeCount, turnId, successPattern }) {
  let prevMessageCount = Number(beforeCount || 0);
  let seenAssistantMessage = null;

  for (const event of events) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const nextMessageCount = Number(event?.messageCount || messages.length || 0);
    const newMessages = nextMessageCount > prevMessageCount
      ? messages.slice(prevMessageCount, nextMessageCount)
      : [];
    const assistantMessage = [...newMessages].reverse().find((message) => (
      message?.role === 'assistant'
      && String(message?.turn || '') === turnId
      && successPattern.test(String(message?.text || ''))
    ));

    if (assistantMessage) {
      seenAssistantMessage = assistantMessage;
    }

    if (seenAssistantMessage && event?.processing === false) {
      return {
        ok: true,
        source: 'sse',
        event,
        assistantMessage: seenAssistantMessage,
      };
    }

    prevMessageCount = nextMessageCount;
  }

  return null;
}

async function waitForProcessingClearedOutcome({ eventStart, beforeCount, successPattern, timeoutMs, label, turnId }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const eventOutcome = findProcessingClearedOutcome(NS.chatEvents.slice(eventStart), {
      beforeCount,
      successPattern,
      turnId,
    });
    if (eventOutcome) {
      return eventOutcome;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`);
}

function deriveProbeLifecycleMilestones(events, opts) {
  const milestones = [];
  let prevMessageCount = Number(opts.beforeCount || 0);
  let prevProcessing = Boolean(opts.beforeProcessing);
  const prompt = String(opts.prompt || '');
  const inProgressText = String(opts.inProgressText || PROBE_IN_PROGRESS_TEXT);

  for (const event of events) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const nextMessageCount = Number(event?.messageCount || messages.length || 0);
    const newMessages = nextMessageCount > prevMessageCount
      ? messages.slice(prevMessageCount, nextMessageCount)
      : [];

    for (const message of newMessages) {
      const role = String(message?.role || '');
      const text = String(message?.text || '');
      if (role === 'user' && text.includes(prompt)) milestones.push('user');
      else if (role === 'system' && text.trim().toLowerCase() === inProgressText) milestones.push('in-progress');
      else if (role === 'assistant' && text.includes(`Echo: ${prompt}`)) milestones.push('assistant');
    }

    const processing = Boolean(event?.processing);
    if (processing !== prevProcessing) milestones.push(processing ? 'processing-true' : 'processing-false');

    prevMessageCount = nextMessageCount;
    prevProcessing = processing;
  }

  return milestones;
}

function matchOrderedProbeLifecycle(events, opts) {
  const milestones = deriveProbeLifecycleMilestones(events, opts);
  if (milestones.length !== 5) return false;
  const firstPair = milestones.slice(0, 2);
  const lastPair = milestones.slice(3, 5);
  const firstOk = firstPair.includes('user') && firstPair.includes('processing-true');
  const middleOk = milestones[2] === 'in-progress';
  const lastOk = lastPair.includes('assistant') && lastPair.includes('processing-false');
  return (firstOk && middleOk && lastOk) ? { milestones } : false;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers,
        });
      });
    }).on('error', reject);
  });
}

function httpJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = payload != null ? JSON.stringify(payload) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpUploadChatFile(url, fileName, content, contentType = 'text/plain; charset=utf-8') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(content, 'utf-8');
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'x-file-name': encodeURIComponent(fileName),
      },
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test sequence
// ---------------------------------------------------------------------------

console.log('\n=== live board HTTP+SSE smoke test ===');
console.log(`target: ${BASE}`);
console.log(`[setup] board id: ${BOARD_ID}`);
console.log(`[setup] board server URL: ${BOARD_SERVER_URL}`);
console.log(`[setup] MCP server URL: ${MCP_SERVER_URL}`);

let serverProc = null;
let sseWorker = null;
let chatSseClient = null;
let chatSseClientId = '';
let watchpartySubscribed = false;
let runCompletedSuccessfully = false;

async function ensureChatSseSubscription() {
  if (!chatSseClientId) {
    chatSseClientId = `chat-proto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  if (!chatSseClient) {
    chatSseClient = startSseClient(`${BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}`, (payload) => {
      captureChatEvents(payload, CHAT_CARD_ID);
      captureWatchpartyEvents(payload, CHAT_CARD_ID, COPILOT_OUTPUT_CHANNEL);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/subscribe-sse`, { clientId: chatSseClientId });
  assert(subRes.status === 200, `chat subscribe returned ${subRes.status}`);
}

async function ensureWatchpartySseSubscription() {
  await ensureChatSseSubscription();
  if (watchpartySubscribed) {
    return;
  }
  const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/watch-channel/${COPILOT_OUTPUT_CHANNEL}/subscribe-sse`, { clientId: chatSseClientId });
  assert(subRes.status === 200, `watchparty subscribe returned ${subRes.status}`);
  watchpartySubscribed = true;
}
try {
  await probeBoardServer();
  await ensureMcpServerRunning(MCP_SERVER_URL);

  // ── Pre-T0 sanitization: cleanup workspace, register board ──

  // cleanupBoardWorkspaceFiles();

  // Register the board via POST (v8 runtime requires explicit registration)
  const regRes = await httpJson('POST', `${BOARD_SERVER_URL}/api/boards`, { id: BOARD_ID, label: BOARD_ID });
  assert(regRes.status === 200 || regRes.status === 201 || regRes.status === 409,
    `POST /api/boards returned ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  console.log(`[setup] board '${BOARD_ID}' registered (${regRes.status})`);

  // ── T0: init, SSE connect, wait for initial completion ──

  console.log('\n=== T0 Step 1: init-board ===');
  const initRes = await httpGet(`${BOARD_SERVER_URL}/api/boards/${BOARD_ID}/init-board`);
  assert(initRes.status === 200, `init-board returned ${initRes.status}`);
  console.log('[T0.1] init-board ok');

  console.log('\n=== T0 Step 1.5: board-status after init-board ===');
  const t0PostInitStatusRes = await httpGet(`${BASE}/board-status`);
  assert(t0PostInitStatusRes.status === 200, `post-init board-status returned ${t0PostInitStatusRes.status}`);
  const t0PostInitSummary = t0PostInitStatusRes.data?.statusSnapshot?.summary;
  assert(t0PostInitSummary, 'post-init statusSnapshot.summary missing from board-status');
  console.log(`[T0.1.5] board-status: ${JSON.stringify(t0PostInitSummary)}`);

  console.log('\n=== T0 Step 2: start SSE worker ===');
  const sseClientId = `server-http-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sseUrl = `${BASE}/sse?clientId=${encodeURIComponent(sseClientId)}`;
  sseWorker = new Worker(SSE_WORKER_SCRIPT, {
    workerData: { sseUrl },
  });
  sseWorker.on('message', (msg) => {
    if (msg.type === 'frame') applyFrame(msg.payload);
    else if (msg.type === 'error') console.error(`[sse-worker] ${msg.message}`);
  });
  sseWorker.on('error', (err) => console.error(`[sse-worker] uncaught: ${err.message}`));

  const initialPayload = await waitForInitialPayload();
  const cardCount = Array.isArray(initialPayload.cardDefinitions) ? initialPayload.cardDefinitions.length : 0;
  assert(cardCount === 3, `expected 3 cards (cardT*), got ${cardCount}`);
  const cardIds = initialPayload.cardDefinitions.map(c => c.id).sort();
  console.log(`[T0.2] SSE initial payload received (${cardCount} cards: ${cardIds.join(', ')})`);

  console.log('\n=== T0 Step 3: wait for all cards to complete ===');
  const t0Summary = await waitForAllCompleted(30_000, 'T0 initial completion');
  assert(t0Summary.failed === 0, `T0 expected failed=0, got ${t0Summary.failed}`);
  console.log(`[T0.3] completed: ${JSON.stringify(t0Summary)}`);

  console.log('\n=== T0 Step 4: board-status cross-check ===');
  const statusRes = await httpGet(`${BASE}/board-status`);
  assert(statusRes.status === 200, `board-status returned ${statusRes.status}`);
  const httpSummary = statusRes.data?.statusSnapshot?.summary;
  assert(httpSummary, 'statusSnapshot.summary missing from board-status');
  assert(httpSummary.completed === httpSummary.card_count, `not all complete: ${JSON.stringify(httpSummary)}`);
  console.log(`[T0.4] board-status: ${JSON.stringify(httpSummary)}`);

  // Verify computed_values arrived for portfolio-value card
  const t0Positions = NS.computedValues['card-portfolio-value']?.positions;
  assert(Array.isArray(t0Positions) && t0Positions.length > 0, 'T0 positions missing from computed_values');
  console.log(`[T0] ok: ${t0Positions.length} positions computed`);

  // ── T1: PATCH holdings (+1 row), verify recomputation ──
  if (skipT1) {
    console.log('\n=== T1: skipped (--skip-t1) ===');
  } else {
    console.log('\n=== T1: patch holdings (+1 row) ===');

  // Read current holdings from card store
  const portfolioCardRes = await httpGet(`${BASE}/cards/card-portfolio`);
  assert(portfolioCardRes.status === 200, `GET card-portfolio returned ${portfolioCardRes.status}`);
  const existingHoldings = portfolioCardRes.data?.card_data?.holdings;
  assert(Array.isArray(existingHoldings), 'card-portfolio.card_data.holdings missing');
  const t0HoldingsCount = existingHoldings.length;
  const t0PositionsCount = t0Positions.length;

  // Pick a ticker not already in holdings
  const candidates = ['AAPL', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOG', 'NVDA', 'NFLX', 'INTC', 'AMD',
    'IBM', 'ORCL', 'ADBE', 'CRM', 'QCOM'];
  const existingTickers = new Set(existingHoldings.map(r => r.ticker));
  const available = candidates.filter(t => !existingTickers.has(t));
  assert(available.length > 0, 'No available ticker to add');
  const newTicker = available[0];

  const newHoldings = [...existingHoldings, { ticker: newTicker, quantity: 1, cost_basis: 100 }];
  const patchRes = await httpJson('PATCH', `${BASE}/cards/card-portfolio`, { card_data: { holdings: newHoldings } });
  assert(patchRes.status === 200, `PATCH card-portfolio returned ${patchRes.status}`);

  // Wait for re-completion after the patch triggers a new cycle
  NS.statusSummary = null;
  await new Promise(r => setTimeout(r, 4000));
  const t1Summary = await waitForAllCompleted(30_000, 'T1 holdings patch');
  assert(t1Summary.failed === 0, `T1 failed=${t1Summary.failed}`);

  // Verify holdings +1 from card store
  const t1PortfolioRes = await httpGet(`${BASE}/cards/card-portfolio`);
  assert(t1PortfolioRes.status === 200, `GET card-portfolio after patch returned ${t1PortfolioRes.status}`);
  const afterHoldings = t1PortfolioRes.data?.card_data?.holdings;
  const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

  // Verify positions +1 from computed_values captured via SSE
  const afterPositions = NS.computedValues['card-portfolio-value']?.positions;
  const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

  assert(afterHoldingsCount === t0HoldingsCount + 1,
    `Expected holdings rows +1 (before=${t0HoldingsCount}, after=${afterHoldingsCount})`);
  assert(afterPositionsCount === t0PositionsCount + 1,
    `Expected positions rows +1 (before=${t0PositionsCount}, after=${afterPositionsCount})`);
  console.log(`[T1] ok: holdings ${t0HoldingsCount}->${afterHoldingsCount}, ` +
    `positions ${t0PositionsCount}->${afterPositionsCount}, added=${newTicker}`);
  }

  // ── T2: plain file upload API + card_data.files + download roundtrip ──
  if (skipT2) {
    console.log('\n=== T2: skipped (--skip-t2) ===');
  } else {
    console.log('\n=== T2: plain file upload -> card_data.files -> download ===');
    const t2CardBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2CardBefore.status === 200, `T2 pre card read returned ${t2CardBefore.status}`);
    const t2FilesBefore = Array.isArray(t2CardBefore.data?.card_data?.files)
      ? t2CardBefore.data.card_data.files
      : [];
    const t2BeforeCount = t2FilesBefore.length;

    const t2UploadText = `plain-file-upload-${Date.now()}`;
    const t2UploadName = 't2-upload.txt';
    const t2UploadRes = await httpUploadChatFile(
      `${BASE}/cards/${CHAT_CARD_ID}/files`,
      t2UploadName,
      t2UploadText,
    );
    assert(t2UploadRes.status === 200, `T2 file upload returned ${t2UploadRes.status}`);
    const t2UploadedFile = t2UploadRes.data?.file;
    assert(t2UploadedFile && typeof t2UploadedFile === 'object', 'T2 upload response missing file metadata');
    assert(String(t2UploadedFile?.name || '') === t2UploadName, 'T2 uploaded file name mismatch');
    assert(!Object.prototype.hasOwnProperty.call(t2UploadedFile, 'path'), 'T2 uploaded file metadata should not expose path');

    const t2CardAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2CardAfter.status === 200, `T2 post card read returned ${t2CardAfter.status}`);
    const t2FilesAfter = Array.isArray(t2CardAfter.data?.card_data?.files)
      ? t2CardAfter.data.card_data.files
      : [];
    assert(t2FilesAfter.length === t2BeforeCount + 1, `T2 expected files +1 (before=${t2BeforeCount}, after=${t2FilesAfter.length})`);

    const t2FileIndex = t2FilesAfter.findIndex((f) => String(f?.stored_name || '') === String(t2UploadedFile?.stored_name || ''));
    assert(t2FileIndex >= 0, 'T2 uploaded file metadata not found in card_data.files');
    const t2StoredFile = t2FilesAfter[t2FileIndex];
    assert(t2StoredFile?.chat === false, 'T2 stored file should be marked as card-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2StoredFile || {}, 'path'), 'T2 stored file metadata should not expose path');

    const t2DownloadRes = await httpGetRaw(
      `${BASE}/cards/${CHAT_CARD_ID}/files/${t2FileIndex}?sn=${encodeURIComponent(String(t2UploadedFile?.stored_name || ''))}`,
    );
    assert(t2DownloadRes.status === 200, `T2 file download returned ${t2DownloadRes.status}`);
    const t2DownloadedText = t2DownloadRes.body.toString('utf-8');
    assert(t2DownloadedText === t2UploadText, 'T2 downloaded content mismatch');
    console.log('[T2] ok: card_data.files updated and file download endpoint returned exact bytes');
  }

  // ── T3*: chat protocol over API + SSE ──
  {
    if (skipT3) {
      console.log('\n=== T3: skipped (--skip-t3) ===');
    } else {
    console.log(`\n[${new Date().toISOString()}] === T3: probe chat protocol (SSE lifecycle) ===`);
  await ensureChatSseSubscription();
  await ensureWatchpartySseSubscription();

  const t2Before = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
  assert(t2Before.status === 200, `T3 pre chats returned ${t2Before.status}`);
  const t2BeforeMessages = Array.isArray(t2Before.data?.messages) ? t2Before.data.messages : [];
  const t2BeforeCount = t2BeforeMessages.length;
  const t2EventStart = NS.chatEvents.length;
  const t2WatchpartyStart = NS.watchpartyEvents.length;
  const t2ProbePrompt = `Probe protocol validation ${Date.now()}`;
  const t2TurnId = randomTurnId();

  const t2SendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
    actionType: 'chat-send',
    payload: {
      text: `${ECHO_PROBE_MARKER}${t2ProbePrompt}${ECHO_PROBE_MARKER}`,
      'turn-id': t2TurnId,
    },
  });
  assert(t2SendRes.status === 200, `T3 chat-send returned ${t2SendRes.status}`);

  const t2Lifecycle = await waitForChatPredicate((events) => {
    return matchOrderedProbeLifecycle(events.slice(t2EventStart), {
      beforeCount: t2BeforeCount,
      beforeProcessing: false,
      prompt: t2ProbePrompt,
      inProgressText: PROBE_IN_PROGRESS_TEXT,
    });
  }, 45_000, 'T3 ordered lifecycle');
  assert(!!t2Lifecycle, 'T3 ordered lifecycle not observed');

  const t2WatchpartyLifecycle = await waitForWatchpartyPredicate((events) => {
    const relevant = events.slice(t2WatchpartyStart);
    const texts = relevant
      .filter((entry) => entry.replace && entry.text)
      .map((entry) => entry.text);
    const sawMarker = texts.some((text) => text.includes("Assistant's Output:"));
    const sawFrame1 = texts.some((text) => text.includes(PROBE_WATCHPARTY_FRAME_1));
    const sawFrame2 = texts.some((text) => text.includes(PROBE_WATCHPARTY_FRAME_2));
    const sawReply = texts.some((text) => text.includes(`Echo: ${t2ProbePrompt}`));
    return sawMarker && sawFrame1 && sawFrame2 && sawReply
      ? { texts }
      : false;
  }, 45_000, 'T3 watchparty lifecycle');
  assert(!!t2WatchpartyLifecycle, 'T3 watchparty lifecycle not observed');

  const t2After = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
  assert(t2After.status === 200, `T3 post chats returned ${t2After.status}`);
  const t2AfterMessages = Array.isArray(t2After.data?.messages) ? t2After.data.messages : [];
  const t2NewMessages = t2AfterMessages.slice(t2BeforeCount);
  assert(t2NewMessages.length >= 3, `T3 expected at least 3 new chat messages, got ${t2NewMessages.length}`);
  const t2User = t2NewMessages.find((m) => m?.role === 'user');
  const t2InProgress = t2NewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
  const t2AssistantMsg = t2NewMessages.find((m) => m?.role === 'assistant');
  assert(!!t2User && typeof t2User.id === 'string', 'T3 user chat message missing id');
  assert(String(t2User?.text || '').includes(t2ProbePrompt), 'T3 user file text mismatch');
  assert(String(t2User?.turn || '') === t2TurnId, 'T3 user turn id mismatch');
  assert(!!t2InProgress && typeof t2InProgress.id === 'string', 'T3 in-progress system message missing id');
  assert(String(t2InProgress?.turn || '') === t2TurnId, 'T3 in-progress system turn id mismatch');
  assert(!!t2AssistantMsg && typeof t2AssistantMsg.id === 'string', 'T3 assistant chat message missing id');
  assert(String(t2AssistantMsg?.text || '').includes(`Echo: ${t2ProbePrompt}`), 'T3 assistant echo file content mismatch');
  assert(String(t2AssistantMsg?.turn || '') === t2TurnId, 'T3 assistant turn id mismatch');
  console.log(`[${new Date().toISOString()}] [T3] ok: ordered probe lifecycle observed (user+processing, in-progress, assistant+processing clear)`);
    }

  // ── T3b: probe-echo chat + file upload protocol over API + SSE ──
  if (skipT3b) {
    console.log('\n=== T3b: skipped (--skip-t3b) ===');
  } else {
    console.log('\n=== T3b: probe-echo chat with file upload protocol ===');
    await ensureChatSseSubscription();
    const t2bBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bBefore.status === 200, `T3b pre chats returned ${t2bBefore.status}`);
    const t2bBeforeMessages = Array.isArray(t2bBefore.data?.messages) ? t2bBefore.data.messages : [];
    const t2bBeforeCount = t2bBeforeMessages.length;
    const t2bTurnId = randomTurnId();

    const t2bUploadRes = await httpUploadChatFile(
      `${BASE}/cards/${CHAT_CARD_ID}/files?inChat=true&turn-id=${encodeURIComponent(t2bTurnId)}`,
      'q1.txt',
      'what is the capital of japan',
    );
    assert(t2bUploadRes.status === 200, `T3b file upload returned ${t2bUploadRes.status}`);
    const uploadedFile = t2bUploadRes.data?.file;
    assert(uploadedFile && typeof uploadedFile === 'object', 'T3b upload response missing file metadata');
    assert(!Object.prototype.hasOwnProperty.call(uploadedFile, 'path'), 'T3b uploaded file metadata should not expose path');

    const t2bCardAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2bCardAfterUpload.status === 200, `T3b card after upload returned ${t2bCardAfterUpload.status}`);
    const t2bStoredFiles = Array.isArray(t2bCardAfterUpload.data?.card_data?.files)
      ? t2bCardAfterUpload.data.card_data.files
      : [];
    const t2bStoredFile = t2bStoredFiles.find((f) => String(f?.stored_name || '') === String(uploadedFile?.stored_name || ''));
    assert(!!t2bStoredFile, 'T3b stored file metadata missing after upload');
    assert(t2bStoredFile?.chat === true, 'T3b stored file should be marked as chat-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2bStoredFile || {}, 'path'), 'T3b stored file metadata should not expose path');

    const t2bAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bAfterUpload.status === 200, `T3b chats after upload returned ${t2bAfterUpload.status}`);
    const t2bUploadMessages = Array.isArray(t2bAfterUpload.data?.messages) ? t2bAfterUpload.data.messages : [];
    const t2bUploadNewMessages = t2bUploadMessages.slice(t2bBeforeCount);
    const t2bUploadSystem = t2bUploadNewMessages.find((m) => m?.role === 'system');
    assert(!!t2bUploadSystem, 'T3b upload protocol missing system chat file');
    assert(String(t2bUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3b upload system message does not describe uploaded file');
    assert(/#\d+\s*$/.test(String(t2bUploadSystem?.text || '')), 'T3b upload system message should include merged file index');
    assert(String(t2bUploadSystem?.turn || '') === t2bTurnId, 'T3b upload system turn id mismatch');

    const t2bSendBaseline = t2bUploadMessages.length;
    const t2bEventStart = NS.chatEvents.length;

    const t2bPrompt = `probe echo file-upload validation ${Date.now()}`;
    const t2bSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: `${ECHO_PROBE_MARKER}${t2bPrompt}${ECHO_PROBE_MARKER}`,
        'turn-id': t2bTurnId,
        files: [uploadedFile],
      },
    });
    assert(t2bSendRes.status === 200, `T3b chat-send returned ${t2bSendRes.status}`);

    const t2bLifecycle = await waitForChatPredicate((events) => {
      return matchOrderedProbeLifecycle(events.slice(t2bEventStart), {
        beforeCount: t2bSendBaseline,
        beforeProcessing: false,
        prompt: t2bPrompt,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3b ordered lifecycle');
    assert(!!t2bLifecycle, 'T3b ordered lifecycle not observed');

    const t2bAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bAfter.status === 200, `T3b post chats returned ${t2bAfter.status}`);
    const t2bAfterMessages = Array.isArray(t2bAfter.data?.messages) ? t2bAfter.data.messages : [];
    const t2bNewMessages = t2bAfterMessages.slice(t2bSendBaseline);
    assert(t2bNewMessages.length >= 3, `T3b expected at least 3 chat messages after send, got ${t2bNewMessages.length}`);

    const t2bUser = t2bNewMessages.find((m) => m?.role === 'user');
    const t2bInProgress = t2bNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2bAssistantMsg = t2bNewMessages.find((m) => m?.role === 'assistant');

    assert(!!t2bUser && typeof t2bUser.id === 'string', 'T3b missing user chat message notification');
    assert(String(t2bUser?.turn || '') === t2bTurnId, 'T3b user turn id mismatch');
    assert(!!t2bInProgress && typeof t2bInProgress.id === 'string', 'T3b missing in-progress system chat message');
    assert(String(t2bInProgress?.turn || '') === t2bTurnId, 'T3b in-progress system turn id mismatch');
    assert(!!t2bAssistantMsg && typeof t2bAssistantMsg.id === 'string', 'T3b missing assistant chat message notification');
    assert(Array.isArray(t2bUser?.files) && t2bUser.files.length === 1, 'T3b user chat message missing uploaded file metadata');
    assert(!Object.prototype.hasOwnProperty.call(t2bUser?.files?.[0] || {}, 'path'), 'T3b user chat file metadata should not expose path');
    assert(String(t2bAssistantMsg?.text || '').includes(`Echo: ${t2bPrompt}`), 'T3b assistant file content mismatch');
    assert(String(t2bAssistantMsg?.turn || '') === t2bTurnId, 'T3b assistant turn id mismatch');
    console.log('[T3b] ok: upload protocol and ordered probe lifecycle observed (user+processing, in-progress, assistant+processing clear)');
  }

  // ── T3d: probe-echo chat with one AI-generated attachment ──
  if (skipT3d) {
    console.log('\n=== T3d: skipped (--skip-t3d) ===');
  } else {
    console.log('\n=== T3d: probe-echo chat with AI-generated attachment ===');
    await ensureChatSseSubscription();
    const t2dBeforeChats = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2dBeforeChats.status === 200, `T3d pre chats returned ${t2dBeforeChats.status}`);
    const t2dBeforeMessages = Array.isArray(t2dBeforeChats.data?.messages) ? t2dBeforeChats.data.messages : [];
    const t2dBeforeCount = t2dBeforeMessages.length;

    const t2dBeforeCard = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2dBeforeCard.status === 200, `T3d pre card returned ${t2dBeforeCard.status}`);
    const t2dBeforeFiles = Array.isArray(t2dBeforeCard.data?.card_data?.files)
      ? t2dBeforeCard.data.card_data.files
      : [];

    const t2dPrompt = `probe generated attachment validation ${Date.now()}`;
    const t2dTurnId = randomTurnId();
    const t2dEventStart = NS.chatEvents.length;
    const t2dSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: `${ECHO_PROBE_MARKER}[attach] ${t2dPrompt}${ECHO_PROBE_MARKER}`,
        'turn-id': t2dTurnId,
      },
    });
    assert(t2dSendRes.status === 200, `T3d chat-send returned ${t2dSendRes.status}`);

    const t2dLifecycle = await waitForChatPredicate((events) => {
      return matchOrderedProbeLifecycle(events.slice(t2dEventStart), {
        beforeCount: t2dBeforeCount,
        beforeProcessing: false,
        prompt: t2dPrompt,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3d ordered lifecycle');
    assert(!!t2dLifecycle, 'T3d ordered lifecycle not observed');

    const t2dAfterChats = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2dAfterChats.status === 200, `T3d post chats returned ${t2dAfterChats.status}`);
    const t2dAfterMessages = Array.isArray(t2dAfterChats.data?.messages) ? t2dAfterChats.data.messages : [];
    const t2dNewMessages = t2dAfterMessages.slice(t2dBeforeCount);
    assert(t2dNewMessages.length >= 4, `T3d expected at least 4 chat messages after send, got ${t2dNewMessages.length}`);

    const t2dInProgress = t2dNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2dAiGenerated = t2dNewMessages.find((m) => m?.role === 'system' && /^AI generated:/i.test(String(m?.text || '')));
    const t2dAssistantMsg = t2dNewMessages.find((m) => m?.role === 'assistant');

    assert(!!t2dInProgress && typeof t2dInProgress.id === 'string', 'T3d missing in-progress system chat message');
    assert(String(t2dInProgress?.turn || '') === t2dTurnId, 'T3d in-progress system turn id mismatch');
    assert(!!t2dAiGenerated && typeof t2dAiGenerated.id === 'string', 'T3d missing AI-generated attachment system chat message');
    assert(/#\d+\s*$/.test(String(t2dAiGenerated?.text || '')), 'T3d AI-generated system message should include merged file index');
    assert(String(t2dAiGenerated?.turn || '') === t2dTurnId, 'T3d AI-generated system turn id mismatch');
    assert(!!t2dAssistantMsg && typeof t2dAssistantMsg.id === 'string', 'T3d missing assistant chat message');
    assert(String(t2dAssistantMsg?.text || '').includes(`Echo: ${t2dPrompt}`), 'T3d assistant content mismatch');
    assert(String(t2dAssistantMsg?.turn || '') === t2dTurnId, 'T3d assistant turn id mismatch');

    const t2dFileIndexMatch = /#(\d+)\s*$/.exec(String(t2dAiGenerated?.text || ''));
    assert(!!t2dFileIndexMatch, 'T3d AI-generated message missing file index');
    const t2dFileIndex = Number.parseInt(t2dFileIndexMatch[1], 10);
    assert(Number.isInteger(t2dFileIndex) && t2dFileIndex >= 0, 'T3d AI-generated message file index should be non-negative');

    const t2dAfterCard = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2dAfterCard.status === 200, `T3d post card returned ${t2dAfterCard.status}`);
    const t2dAfterFiles = Array.isArray(t2dAfterCard.data?.card_data?.files)
      ? t2dAfterCard.data.card_data.files
      : [];
    assert(t2dAfterFiles.length === t2dBeforeFiles.length + 1, `T3d expected exactly one new stored file, got ${t2dAfterFiles.length - t2dBeforeFiles.length}`);
    const t2dStoredFile = t2dAfterFiles[t2dFileIndex];
    assert(!!t2dStoredFile, `T3d stored file missing at merged index ${t2dFileIndex}`);
    assert(t2dStoredFile?.chat === true, 'T3d generated file should be marked as chat-origin');
    assert(String(t2dStoredFile?.stored_name || '').length > 0, 'T3d generated file stored_name missing');
    assert(!Object.prototype.hasOwnProperty.call(t2dStoredFile || {}, 'path'), 'T3d stored file metadata should not expose path');
    console.log('[T3d] ok: probe staged one AI-generated attachment and appended the final reply through the shared flow');
  }

  // ── T3a: non-probe chat protocol over API + SSE ──
  // Disabled in the public example unless explicitly requested — requires a
  // configured Azure Foundry endpoint and agent_id in server-config.json.
  if (skipT3a) {
    const reason = cliArgs.includes('--skip-t3a')
      ? '--skip-t3a'
      : (skipT3 ? 'T3 group skipped' : (!isTestSelected('T3A') ? 'not in --tests selection' : (!isCopilotAvailable() ? 'copilot CLI unavailable' : 'skipped')));
    console.log(`\n=== T3a: skipped (${reason}) ===`);
  } else {
    console.log('\n=== T3a: non-probe chat protocol (expect paris) ===');
    await ensureChatSseSubscription();
    const t2aBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2aBefore.status === 200, `T3a pre chats returned ${t2aBefore.status}`);
    const t2aBeforeMessages = Array.isArray(t2aBefore.data?.messages) ? t2aBefore.data.messages : [];
    const t2aBeforeCount = t2aBeforeMessages.length;
    const t2aEventStart = NS.chatEvents.length;
    const t2aPrompt = 'Just answer what is the capital of France. No Fluff. No COmmentary.  No Markup Respond in lower case in one word.';
    const t2aTurnId = randomTurnId();

    const t2aSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: t2aPrompt,
        'turn-id': t2aTurnId,
      },
    });
    assert(t2aSendRes.status === 200, `T3a chat-send returned ${t2aSendRes.status}`);

    const t2aOutcome = await waitForAssistantOutcome({
      eventStart: t2aEventStart,
      beforeCount: t2aBeforeCount,
      successPattern: /paris/i,
      turnId: t2aTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3a assistant response with paris',
    });
    assert(t2aOutcome.ok, `T3a failed before assistant response: ${t2aOutcome.reason || 'unknown reason'}`);
    assert(t2aOutcome.source === 'sse', 'T3a should resolve from SSE chat notifications');
    const t2aSettledOutcome = await waitForProcessingClearedOutcome({
      eventStart: t2aEventStart,
      beforeCount: t2aBeforeCount,
      successPattern: /paris/i,
      turnId: t2aTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3a processing cleared after assistant response',
    });
    assert(t2aSettledOutcome.ok, 'T3a should observe processing=false after assistant response');
    assert(t2aSettledOutcome.source === 'sse', 'T3a processing clear should resolve from SSE chat notifications');
    assert(t2aSettledOutcome.event?.processing === false, 'T3a final SSE event should clear processing');

    const t2aMessages = Array.isArray(t2aSettledOutcome?.event?.messages) ? t2aSettledOutcome.event.messages : [];
    const t2aSseNewMessages = t2aMessages.slice(t2aBeforeCount);
    assert(t2aSseNewMessages.length >= 1, `T3a expected at least 1 new SSE chat message, got ${t2aSseNewMessages.length}`);
    const t2aAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2aAfter.status === 200, `T3a post chats returned ${t2aAfter.status}`);
    const t2aAfterMessages = Array.isArray(t2aAfter.data?.messages) ? t2aAfter.data.messages : [];
    const t2aNewMessages = t2aAfterMessages.slice(t2aBeforeCount);
    assert(t2aNewMessages.length >= 2, `T3a expected at least 2 new chat messages, got ${t2aNewMessages.length}`);
    const t2aUser = t2aNewMessages.find((m) => m?.role === 'user');
    const t2aAssistantMsg = [...t2aNewMessages].reverse().find((m) => m?.role === 'assistant');
    assert(!!t2aUser && typeof t2aUser.id === 'string', 'T3a user chat message missing id');
    assert(String(t2aUser?.turn || '') === t2aTurnId, 'T3a user turn id mismatch');
    assert(!!t2aAssistantMsg && typeof t2aAssistantMsg.id === 'string', 'T3a assistant chat message missing id');
    assert(/paris/i.test(String(t2aAssistantMsg?.text || '')), 'T3a assistant file content missing paris');
    assert(String(t2aAssistantMsg?.turn || '') === t2aTurnId, 'T3a assistant turn id mismatch');
    for (const message of t2aNewMessages.filter((m) => m?.role === 'system')) {
      assert(String(message?.turn || '') === t2aTurnId, 'T3a system turn id mismatch');
    }
    console.log('[T3a] ok: non-probe response contains paris and SSE clears processing');
  }

  // ── T3c: non-probe chat + file upload protocol over API + SSE ──
  if (skipT3c) {
    console.log('\n=== T3c: skipped (--skip-t3c) ===');
  } else {
    console.log('\n=== T3c: non-probe chat with file upload protocol (expect tokyo) ===');
    await ensureChatSseSubscription();
    const t2cBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2cBefore.status === 200, `T3c pre chats returned ${t2cBefore.status}`);
    const t2cBeforeMessages = Array.isArray(t2cBefore.data?.messages) ? t2cBefore.data.messages : [];
    const t2cBeforeCount = t2cBeforeMessages.length;
    const t2cTurnId = randomTurnId();

    const t2cUploadRes = await httpUploadChatFile(
      `${BASE}/cards/${CHAT_CARD_ID}/files?inChat=true&turn-id=${encodeURIComponent(t2cTurnId)}`,
      'q2.txt',
      'What is the captial of Japan',
    );
    assert(t2cUploadRes.status === 200, `T3c file upload returned ${t2cUploadRes.status}`);
    const t2cUploadedFile = t2cUploadRes.data?.file;
    assert(t2cUploadedFile && typeof t2cUploadedFile === 'object', 'T3c upload response missing file metadata');
    assert(!Object.prototype.hasOwnProperty.call(t2cUploadedFile, 'path'), 'T3c uploaded file metadata should not expose path');

    const t2cCardAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2cCardAfterUpload.status === 200, `T3c card after upload returned ${t2cCardAfterUpload.status}`);
    const t2cStoredFiles = Array.isArray(t2cCardAfterUpload.data?.card_data?.files)
      ? t2cCardAfterUpload.data.card_data.files
      : [];
    const t2cStoredFile = t2cStoredFiles.find((f) => String(f?.stored_name || '') === String(t2cUploadedFile?.stored_name || ''));
    assert(!!t2cStoredFile, 'T3c stored file metadata missing after upload');
    assert(t2cStoredFile?.chat === true, 'T3c stored file should be marked as chat-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2cStoredFile || {}, 'path'), 'T3c stored file metadata should not expose path');

    const t2cAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2cAfterUpload.status === 200, `T3c chats after upload returned ${t2cAfterUpload.status}`);
    const t2cUploadMessages = Array.isArray(t2cAfterUpload.data?.messages) ? t2cAfterUpload.data.messages : [];
    const t2cUploadNewMessages = t2cUploadMessages.slice(t2cBeforeCount);
    const t2cUploadSystem = t2cUploadNewMessages.find((m) => m?.role === 'system');
    assert(!!t2cUploadSystem, 'T3c upload protocol missing system chat file');
    assert(String(t2cUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3c upload system message does not describe uploaded file');
    assert(/#\d+\s*$/.test(String(t2cUploadSystem?.text || '')), 'T3c upload system message should include merged file index');
    assert(String(t2cUploadSystem?.turn || '') === t2cTurnId, 'T3c upload system turn id mismatch');

    const t2cSendBaseline = t2cUploadMessages.length;
    const t2cEventStart = NS.chatEvents.length;
    const t2cPrompt = 'Answer the question in the attached file in one word';

    const t2cSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: t2cPrompt,
        'turn-id': t2cTurnId,
        files: [t2cUploadedFile],
      },
    });
    assert(t2cSendRes.status === 200, `T3c chat-send returned ${t2cSendRes.status}`);

    const t2cOutcome = await waitForAssistantOutcome({
      eventStart: t2cEventStart,
      beforeCount: t2cSendBaseline,
      successPattern: /tokyo/i,
      turnId: t2cTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3c assistant response with tokyo',
    });
    assert(t2cOutcome.ok, `T3c failed before assistant response: ${t2cOutcome.reason || 'unknown reason'}`);
    assert(t2cOutcome.source === 'sse', 'T3c should resolve from SSE chat notifications');
    const t2cSettledOutcome = await waitForProcessingClearedOutcome({
      eventStart: t2cEventStart,
      beforeCount: t2cSendBaseline,
      successPattern: /tokyo/i,
      turnId: t2cTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3c processing cleared after assistant response',
    });
    assert(t2cSettledOutcome.ok, 'T3c should observe processing=false after assistant response');
    assert(t2cSettledOutcome.source === 'sse', 'T3c processing clear should resolve from SSE chat notifications');
    assert(t2cSettledOutcome.event?.processing === false, 'T3c final SSE event should clear processing');

    const t2cMessages = Array.isArray(t2cSettledOutcome?.event?.messages) ? t2cSettledOutcome.event.messages : [];
    const t2cSseNewMessages = t2cMessages.slice(t2cSendBaseline);
    assert(t2cSseNewMessages.length >= 1, `T3c expected at least 1 new SSE chat message, got ${t2cSseNewMessages.length}`);
    const t2cAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2cAfter.status === 200, `T3c post chats returned ${t2cAfter.status}`);
    const t2cAfterMessages = Array.isArray(t2cAfter.data?.messages) ? t2cAfter.data.messages : [];
    const t2cNewMessages = t2cAfterMessages.slice(t2cSendBaseline);
    assert(t2cNewMessages.length >= 2, `T3c expected at least 2 new chat messages, got ${t2cNewMessages.length}`);
    const t2cUser = t2cNewMessages.find((m) => m?.role === 'user');
    const t2cAssistantMsg = [...t2cNewMessages].reverse().find((m) => m?.role === 'assistant');
    assert(!!t2cUser, 'T3c user chat message missing from stored chats');
    assert(String(t2cUser?.turn || '') === t2cTurnId, 'T3c user turn id mismatch');
    assert(Array.isArray(t2cUser?.files) && t2cUser.files.length === 1, 'T3c user chat message missing uploaded file metadata');
    assert(!Object.prototype.hasOwnProperty.call(t2cUser?.files?.[0] || {}, 'path'), 'T3c user chat file metadata should not expose path');
    assert(!!t2cAssistantMsg, 'T3c assistant chat message missing from SSE payload');
    assert(/tokyo/i.test(String(t2cAssistantMsg?.text || '')), 'T3c assistant file content missing tokyo');
    assert(String(t2cAssistantMsg?.turn || '') === t2cTurnId, 'T3c assistant turn id mismatch');
    console.log('[T3c] ok: non-probe file-upload response contains tokyo and SSE clears processing');
  }
  }

  console.log('\n=== All smoke checks passed ===\n');
  runCompletedSuccessfully = true;
} finally {
  if (chatSseClientId) {
    try {
      if (watchpartySubscribed) {
        await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/watch-channel/${COPILOT_OUTPUT_CHANNEL}/unsubscribe-sse`, { clientId: chatSseClientId });
      }
    } catch { /* ignore */ }
    try {
      await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/unsubscribe-sse`, { clientId: chatSseClientId });
    } catch { /* ignore */ }
  }
  if (chatSseClient) chatSseClient.close();
  if (serverProc) {
    serverProc.kill();
    await new Promise((r) => serverProc.on('exit', r));
  }
  if (sseWorker) await sseWorker.terminate();
}
