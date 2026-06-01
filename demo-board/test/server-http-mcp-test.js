#!/usr/bin/env node
/**
 * server-http-mcp-test.js
 *
 * Smoke test for demo-board/server/board-server.js over HTTP + SSE.
 * Targets a named board (defined in server-config.json) using the 3
 * seed cards in demo-board/test/live-cards/.
 *
 * Prerequisites:
 *   - Board server running at port 7799 with demo-board/server-config.json
 *   - MCP server running at port 7801
 *   The test attaches to the running server — it does NOT spawn its own.
 *
 * T0: resync → init-board → SSE initial payload → wait for all cards to complete
 * T1: direct /mcp endpoint — PATCH holdings (+1 row) → verify recomputation
 * T1a: liveboards.* MCP tools — same mutation via MCP server at 7801
 *
 * Usage:
 *   node test/server-http-mcp-test.js [--board-id live-test] [--port 7799] [--run-tests T1,T1A]
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const AGENT_OUTPUT_CHANNEL = 'agent-output';

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

const boardIdArg = cliArgs.indexOf('--board-id');
const boardAliasArg = cliArgs.indexOf('--board');
const cliBoardId = boardIdArg !== -1
  ? String(cliArgs[boardIdArg + 1] || '').trim()
  : (boardAliasArg !== -1 ? String(cliArgs[boardAliasArg + 1] || '').trim() : '');
const BOARD_ID = cliBoardId || (process.env.DEMO_BOARD_ID || '').trim() || 'live-test';
const BOARD_DIR = path.resolve(__dirname, '..');
const SERVER_CONFIG_PATH = path.resolve(BOARD_DIR, 'server-config.json');

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

const skipT1 = cliArgs.includes('--skip-t1') || !isTestSelected('T1');
const skipT1a = cliArgs.includes('--skip-t1a') || !isTestSelected('T1A');
const skipT2 = cliArgs.includes('--skip-t2') || !isTestSelected('T2');
const skipT3 = cliArgs.includes('--skip-t3') || !isAnyTestSelected(['T3', 'T3A', 'T3B', 'T3C', 'T3D']);
const skipT4 = cliArgs.includes('--skip-t4') || !isTestSelected('T4');
const forceT3aBypass = process.env.DEMO_T3A_BYPASS === '1';
let __copilotAvailableCache = null;
function isCopilotAvailable() {
  if (__copilotAvailableCache !== null) return __copilotAvailableCache;
  const envOverride = process.env.DEMO_COPILOT_AVAILABLE;
  if (envOverride === '0' || envOverride === 'false') { __copilotAvailableCache = false; return false; }
  if (envOverride === '1' || envOverride === 'true') { __copilotAvailableCache = true; return true; }
  __copilotAvailableCache = false;
  return false;
}

let __boardChatAssistantCache = null;
function getBoardChatAssistant() {
  if (__boardChatAssistantCache !== null) return __boardChatAssistantCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf-8'));
    __boardChatAssistantCache = String(cfg?.boards?.[BOARD_ID]?.chat?.assistant || 'copilot').toLowerCase();
  } catch {
    __boardChatAssistantCache = 'copilot';
  }
  return __boardChatAssistantCache;
}

function boardRequiresCopilotCli() {
  return getBoardChatAssistant() === 'copilot';
}

const skipT3a = skipT3 || cliArgs.includes('--skip-t3a') || !isTestSelected('T3A') || (!forceT3aBypass && boardRequiresCopilotCli() && !isCopilotAvailable());
const skipT3b = skipT3 || cliArgs.includes('--skip-t3b') || !isTestSelected('T3B');
const skipT3c = skipT3 || cliArgs.includes('--skip-t3c') || !isTestSelected('T3C') || (boardRequiresCopilotCli() && !isCopilotAvailable());
const skipT3d = skipT3 || cliArgs.includes('--skip-t3d') || !isTestSelected('T3D');

const BOARD_SERVER_URL = 'http://127.0.0.1:7799';
const SSE_WORKER_SCRIPT = path.join(__dirname, 'sse-worker.js');
const CHAT_CARD_ID = 'card-portfolio';
const PORTFOLIO_SEED_CARD_PATH = path.join(__dirname, 'live-cards', 'cardT-portfolio.json');
const PORTFOLIO_SEED_CARD = JSON.parse(fs.readFileSync(PORTFOLIO_SEED_CARD_PATH, 'utf-8'));
const PORTFOLIO_SEED_HOLDINGS = Array.isArray(PORTFOLIO_SEED_CARD?.card_data?.holdings)
  ? PORTFOLIO_SEED_CARD.card_data.holdings
  : [];
const T1_ADDED_TICKER_CANDIDATES = ['AMZN', 'AMD', 'NVDA', 'ORCL'];

function chooseT1AddedTicker(existingHoldings) {
  const occupied = new Set(
    Array.isArray(existingHoldings)
      ? existingHoldings
        .map((row) => String(row?.ticker || '').trim().toUpperCase())
        .filter(Boolean)
      : [],
  );
  const selected = T1_ADDED_TICKER_CANDIDATES.find((ticker) => !occupied.has(ticker));
  if (!selected) {
    throw new Error(`Unable to find an unused T1 ticker for board ${BOARD_ID}`);
  }
  return selected;
}

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

loadBoardSetupConfig(BOARD_ID);

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

async function ensureMcpServerRunning(serverUrl) {
  if (await probeMcpServer(serverUrl)) {
    console.log(`[setup] MCP server already available at ${serverUrl}`);
    return;
  }

  throw new Error(`MCP server is down at ${serverUrl}. Start it before running server-http-mcp-test.`);
}

function probeBoardServer(timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BOARD_SERVER_URL}/healthz`, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            console.log(`[setup] board server running at ${BOARD_SERVER_URL} (pid=${data.pid}, uptime=${Math.round((data.uptimeMs || 0) / 1000)}s)`);
          } catch { /* ignore parse error */ }
          resolve();
        } else {
          reject(new Error(`Board server at ${BOARD_SERVER_URL} returned HTTP ${res.statusCode}. Start it before running server-http-mcp-test.`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Board server not reachable at ${BOARD_SERVER_URL}: ${err.message}. Start it before running server-http-mcp-test.`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Board server at ${BOARD_SERVER_URL} did not respond within ${timeoutMs}ms. Start it before running server-http-mcp-test.`));
    });
    req.end();
  });
}

const PORT = 7799;
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

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

async function waitForTurnMessages({ cardId, turnId, timeoutMs, label, predicate }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const messages = await readLiveCardChats(cardId, {
      'turn-id': turnId,
    });
    const result = predicate(messages);
    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`);
}

function deriveProbeLifecycleMilestones(events, opts) {
  const milestones = [];
  const seenMessageIds = new Set();
  let prevProcessing = Boolean(opts.beforeProcessing);
  const prompt = String(opts.prompt || '');
  const inProgressText = String(opts.inProgressText || PROBE_IN_PROGRESS_TEXT);
  const expectGeneratedAttachment = opts?.expectGeneratedAttachment === true;
  const turnId = String(opts.turnId || '');

  for (const event of events) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const turnMessages = turnId
      ? messages.filter((m) => String(m?.turn || '') === turnId)
      : messages;

    for (const message of turnMessages) {
      const key = message?.id || `${message?.role}:${message?.text}`;
      if (seenMessageIds.has(key)) continue;
      seenMessageIds.add(key);
      const role = String(message?.role || '');
      const text = String(message?.text || '');
      if (role === 'user' && text.includes(prompt)) milestones.push('user');
      else if (role === 'system' && text.trim().toLowerCase() === inProgressText) milestones.push('in-progress');
      else if (expectGeneratedAttachment && role === 'system' && /^AI generated:/i.test(text)) milestones.push('ai-generated');
      else if (role === 'assistant' && text.includes(`Echo: ${prompt}`)) milestones.push('assistant');
    }

    const processing = Boolean(event?.processing);
    if (processing !== prevProcessing) milestones.push(processing ? 'processing-true' : 'processing-false');
    prevProcessing = processing;
  }

  return milestones;
}

function matchOrderedProbeLifecycle(events, opts) {
  const milestones = deriveProbeLifecycleMilestones(events, opts);
  if (opts?.expectGeneratedAttachment === true) {
    if (milestones.length !== 6) return false;
    const firstPair = milestones.slice(0, 2);
    const tail = milestones.slice(3, 6);
    const firstOk = firstPair.includes('user') && firstPair.includes('processing-true');
    const middleOk = milestones[2] === 'in-progress';
    const tailOk = tail[0] === 'ai-generated' && tail.includes('assistant') && tail.includes('processing-false');
    return (firstOk && middleOk && tailOk) ? { milestones } : false;
  }

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

let mcpClient = null;
let mcpTransport = null;

async function getMcpClient() {
  if (mcpClient) return mcpClient;
  mcpTransport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
  const client = new Client({ name: 'server-http-mcp-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(mcpTransport);
  mcpClient = client;
  return client;
}

async function closeMcpClient() {
  try { if (mcpClient) await mcpClient.close(); } catch { /* ignore */ }
  try { if (mcpTransport) await mcpTransport.close(); } catch { /* ignore */ }
  mcpClient = null;
  mcpTransport = null;
}

async function listLiveboardsToolNames() {
  const client = await getMcpClient();
  const response = await client.listTools();
  return Array.isArray(response?.tools)
    ? response.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
    : [];
}

function sanitizeWatchpartyToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function deriveLogIdForTest(args) {
  const cardId = typeof args?.card_id === 'string' && args.card_id.trim()
    ? args.card_id.trim()
    : CHAT_CARD_ID;
  return `0${sanitizeWatchpartyToken(cardId)}`;
}

async function callLiveboards(toolName, args) {
  const client = await getMcpClient();
  const toolArgs = {
    ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}),
    log_id: deriveLogIdForTest(args),
  };
  const result = await client.callTool({ name: toolName, arguments: toolArgs });
  if (result?.isError) {
    const text = Array.isArray(result?.content)
      ? result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';
    throw new Error(`${toolName} failed: ${text || JSON.stringify(result)}`);
  }
  if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    return result.structuredContent;
  }
  const text = Array.isArray(result?.content)
    ? result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
    : '';
  if (Array.isArray(result?.content) && result.content.length > 0) {
    return result.content;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function expectLiveboardsSuccess(result, label) {
  assert(result?.status === 'success', `${label} failed: ${JSON.stringify(result)}`);
  return result?.data ?? null;
}

async function callBoardServerMcp(toolName, args) {
  const result = await httpJson('POST', `${BASE}/mcp`, {
    tool: toolName,
    args,
  });
  assert(result.status === 200, `${toolName} returned ${result.status}`);
  return result.data;
}

function expectBoardServerMcpSuccess(result, label) {
  assert(result?.status === 'success', `${label} failed: ${JSON.stringify(result)}`);
  return result?.data ?? null;
}

async function readLiveCard(cardId) {
  const result = await callLiveboards('liveboards.manage.read-card', {
    board_id: BOARD_ID,
    card_id: cardId,
  });
  return Array.isArray(result?.data) ? result.data[0] : null;
}

async function readCardDefinitionAndRuntimeViaLiveboards(cardId) {
  const result = await callLiveboards('liveboards.inspect.card-definition-and-runtime', {
    board_id: BOARD_ID,
    card_id: cardId,
  });
  assert(result?.status === 'success', `liveboards.inspect.card-definition-and-runtime failed: ${JSON.stringify(result)}`);
  return result?.data ?? null;
}

async function restorePortfolioSeedCard(label) {
  const restoreCard = JSON.parse(JSON.stringify(PORTFOLIO_SEED_CARD));
  const restoreRes = await callLiveboards('liveboards.manage.upsert-card', {
    board_id: BOARD_ID,
    card_id: restoreCard.id,
    candidate_card_content: restoreCard,
  });
  expectLiveboardsSuccess(restoreRes, `${label}: liveboards.manage.upsert-card`);

  NS.statusSummary = null;
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const restoreSummary = await waitForAllCompleted(30_000, `${label}: restore seed portfolio`);
  assert(restoreSummary.failed === 0, `${label}: restore seed portfolio failed=${restoreSummary.failed}`);

  const restoredPortfolio = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio');
  const restoredCard = restoredPortfolio?.card_definition_and_static_data ?? null;
  const restoredHoldings = restoredCard?.card_data?.holdings;
  assert(Array.isArray(restoredHoldings), `${label}: restored holdings missing`);
  assert(
    JSON.stringify(restoredHoldings) === JSON.stringify(PORTFOLIO_SEED_HOLDINGS),
    `${label}: restored holdings do not match seed card`,
  );

  const restoredPortfolioValue = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio-value');
  const restoredPositions = restoredPortfolioValue?.runtime_data?.computed_values?.positions;
  assert(Array.isArray(restoredPositions), `${label}: restored runtime positions missing`);
  assert(
    restoredPositions.length === PORTFOLIO_SEED_HOLDINGS.length,
    `${label}: restored positions count mismatch (holdings=${PORTFOLIO_SEED_HOLDINGS.length}, positions=${restoredPositions.length})`,
  );

  return {
    card: restoredCard,
    holdings: restoredHoldings,
    positionsCount: restoredPositions.length,
  };
}

async function readLiveCardChats(cardId, args = {}) {
  const result = await callLiveboards('liveboards.inspect.chat-messages-on-cards', {
    board_id: BOARD_ID,
    card_id: cardId,
    ...args,
  });
  return Array.isArray(result?.data?.messages) ? result.data.messages : [];
}

// ---------------------------------------------------------------------------
// Test sequence
// ---------------------------------------------------------------------------

console.log(`\n=== ${BOARD_ID} board HTTP+SSE+MCP smoke test ===`);
console.log(`target: ${BASE}`);
console.log(`[setup] MCP server URL: ${MCP_SERVER_URL}`);

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
      captureWatchpartyEvents(payload, CHAT_CARD_ID, AGENT_OUTPUT_CHANNEL);
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
  const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/watch-channel/${AGENT_OUTPUT_CHANNEL}/subscribe-sse`, { clientId: chatSseClientId });
  assert(subRes.status === 200, `watchparty subscribe returned ${subRes.status}`);
  watchpartySubscribed = true;
}
try {
  await probeBoardServer();
  await ensureMcpServerRunning(MCP_SERVER_URL);

  // ── Pre-T0 sanitization: cleanup workspace, register board ──

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

  // ── T1: read, upsert, and read back via liveboards.* MCP tools ──
  if (skipT1) {
    console.log('\n=== T1: skipped (--skip-t1) ===');
  } else {
    console.log('\n=== T1: liveboards.* read + upsert (+1 row) ===');

    const t1StatusBefore = await callLiveboards('liveboards.inspect.board-runtime-status', { board_id: BOARD_ID });
    const t1StatusBeforeSummary = expectLiveboardsSuccess(t1StatusBefore, 'T1 preflight liveboards.inspect.board-runtime-status')?.summary;
    assert(t1StatusBeforeSummary, 'T1 preflight liveboards.inspect.board-runtime-status missing summary');
    console.log(`[T1] preflight board-status: ${JSON.stringify(t1StatusBeforeSummary)}`);

    const t1ReadBefore = await callLiveboards('liveboards.manage.read-card', {
      board_id: BOARD_ID,
      card_id: 'card-portfolio',
    });
    const t1ReadBeforeCard = Array.isArray(expectLiveboardsSuccess(t1ReadBefore, 'T1 preflight liveboards.manage.read-card'))
      ? expectLiveboardsSuccess(t1ReadBefore, 'T1 preflight liveboards.manage.read-card')[0]
      : null;
    assert(t1ReadBeforeCard && typeof t1ReadBeforeCard === 'object', 'T1 preflight liveboards.manage.read-card returned no card');
    console.log(`[T1] preflight liveboards.manage.read-card ok: ${String(t1ReadBeforeCard?.id || '')}`);

    const restored = await restorePortfolioSeedCard('T1 precondition');
    const existingCard = restored.card;
    const existingHoldings = restored.holdings;
    const t0HoldingsCount = existingHoldings.length;
    const t0PositionsCount = restored.positionsCount;
    const newTicker = chooseT1AddedTicker(existingHoldings);

    const newHoldings = [...existingHoldings, { ticker: newTicker, quantity: 1, cost_basis: 100 }];
    const nextCard = {
      ...existingCard,
      card_data: {
        ...(existingCard.card_data || {}),
        holdings: newHoldings,
      },
    };

    const upsertRes = await callLiveboards('liveboards.manage.upsert-card', {
      board_id: BOARD_ID,
      card_id: 'card-portfolio',
      candidate_card_content: nextCard,
    });
    expectLiveboardsSuccess(upsertRes, 'liveboards.manage.upsert-card');

    // Wait for re-completion after the upsert triggers a new cycle
    NS.statusSummary = null;
    await new Promise(r => setTimeout(r, 4000));
    const t1Summary = await waitForAllCompleted(30_000, 'T1 holdings upsert');
    assert(t1Summary.failed === 0, `T1 failed=${t1Summary.failed}`);

    // Read back via liveboards.inspect.card-definition-and-runtime
    const readAfter = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio');
    const afterCard = readAfter?.card_definition_and_static_data ?? null;
    const afterHoldings = afterCard?.card_data?.holdings;
    const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

    const runtimeAfter = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio-value');
    const afterPositions = runtimeAfter?.runtime_data?.computed_values?.positions;
    const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

    assert(afterHoldingsCount === t0HoldingsCount + 1,
      `Expected holdings rows +1 (before=${t0HoldingsCount}, after=${afterHoldingsCount})`);
    assert(afterPositionsCount === t0PositionsCount + 1,
      `Expected positions rows +1 (before=${t0PositionsCount}, after=${afterPositionsCount})`);
    console.log(`[T1] ok: holdings ${t0HoldingsCount}->${afterHoldingsCount}, ` +
      `positions ${t0PositionsCount}->${afterPositionsCount}, added=${newTicker}`);
  }

  // ── T1a: same sequence as T1, but routed through the liveboards MCP tools ──
  if (skipT1a) {
    console.log('\n=== T1a: skipped (--skip-t1a) ===');
  } else {
    console.log('\n=== T1a: liveboards.* read + upsert (+1 row) ===');

    const liveboardsTools = await listLiveboardsToolNames();
    assert(liveboardsTools.includes('liveboards.manage.remove-card'),
      `T1a expected MCP tools/list to include liveboards.manage.remove-card; got ${JSON.stringify(liveboardsTools)}`);

    const restored = await restorePortfolioSeedCard('T1a precondition');
    const existingCard = restored.card;
    const existingHoldings = restored.holdings;
    const t1aHoldingsBeforeCount = existingHoldings.length;
    const t1aPositionsBeforeCount = restored.positionsCount;
    const newTicker = chooseT1AddedTicker(existingHoldings);

    const newHoldings = [...existingHoldings, { ticker: newTicker, quantity: 1, cost_basis: 100 }];
    const nextCard = {
      ...existingCard,
      card_data: {
        ...(existingCard.card_data || {}),
        holdings: newHoldings,
      },
    };

    const statusBefore = await callLiveboards('liveboards.inspect.board-runtime-status', {
      board_id: BOARD_ID,
    });
    assert(statusBefore?.status === 'success', `T1a liveboards.inspect.board-runtime-status failed: ${JSON.stringify(statusBefore)}`);

    const readBefore = await callLiveboards('liveboards.manage.read-card', {
      board_id: BOARD_ID,
      card_id: 'card-portfolio',
    });
    const readBeforeCard = Array.isArray(readBefore?.data) ? readBefore.data[0] : null;
    assert(readBeforeCard && typeof readBeforeCard === 'object', 'T1a liveboards.manage.read-card returned no card');

    const upsertRes = await callLiveboards('liveboards.manage.upsert-card', {
      board_id: BOARD_ID,
      card_id: 'card-portfolio',
      candidate_card_content: nextCard,
    });
    assert(upsertRes?.status === 'success', `T1a liveboards.manage.upsert-card failed: ${JSON.stringify(upsertRes)}`);

    NS.statusSummary = null;
    await new Promise(r => setTimeout(r, 4000));
    const t1aSummary = await waitForAllCompleted(30_000, 'T1a holdings upsert');
    assert(t1aSummary.failed === 0, `T1a failed=${t1aSummary.failed}`);

    const statusAfter = await callLiveboards('liveboards.inspect.board-runtime-status', {
      board_id: BOARD_ID,
    });
    assert(statusAfter?.status === 'success', `T1a liveboards.inspect.board-runtime-status post-check failed: ${JSON.stringify(statusAfter)}`);
    const statusAfterSummary = statusAfter?.data?.summary;
    assert(statusAfterSummary?.failed === 0, `T1a expected failed=0 after upsert, got ${JSON.stringify(statusAfterSummary)}`);

    const readAfter = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio');
    const afterCard = readAfter?.card_definition_and_static_data ?? null;
    const afterHoldings = afterCard?.card_data?.holdings;
    const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

    const runtimeAfter = await readCardDefinitionAndRuntimeViaLiveboards('card-portfolio-value');
    const afterPositions = runtimeAfter?.runtime_data?.computed_values?.positions;
    const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

    assert(afterHoldingsCount === t1aHoldingsBeforeCount + 1,
      `T1a expected holdings rows +1 (before=${t1aHoldingsBeforeCount}, after=${afterHoldingsCount})`);
    assert(afterPositionsCount === t1aPositionsBeforeCount + 1,
      `T1a expected positions rows +1 (before=${t1aPositionsBeforeCount}, after=${afterPositionsCount})`);
    console.log(`[T1a] ok: holdings ${t1aHoldingsBeforeCount}->${afterHoldingsCount}, ` +
      `positions ${t1aPositionsBeforeCount}->${afterPositionsCount}, added=${newTicker}`);
  }

  // ── T2: plain file upload API + card_data.files + download roundtrip ──
  if (skipT2) {
    console.log('\n=== T2: skipped (--skip-t2) ===');
  } else {
    console.log('\n=== T2: plain file upload -> MCP read-card -> MCP file-contents ===');
    const t2CardBefore = await callLiveboards('liveboards.manage.read-card', {
      board_id: BOARD_ID,
      card_id: CHAT_CARD_ID,
    });
    const t2CardBeforeData = Array.isArray(t2CardBefore?.data) ? t2CardBefore.data[0] : null;
    assert(t2CardBeforeData && typeof t2CardBeforeData === 'object', 'T2 pre read-card returned no card');
    const t2FilesBefore = Array.isArray(t2CardBeforeData?.card_data?.files)
      ? t2CardBeforeData.card_data.files
      : [];
    const t2BeforeCount = t2FilesBefore.length;

    const t2UploadText = `plain-file-upload-${Date.now()}`;
    const t2UploadName = 't2-upload.txt';
    const t2UploadRes = await callBoardServerMcp('manage.upload-card-file', {
      card_id: CHAT_CARD_ID,
      file_name: t2UploadName,
      content_type: 'text/plain; charset=utf-8',
      text: t2UploadText,
    });
    const t2UploadedFile = expectBoardServerMcpSuccess(t2UploadRes, 'T2 manage.upload-card-file')?.file;
    assert(t2UploadedFile && typeof t2UploadedFile === 'object', 'T2 upload response missing file metadata');
    assert(String(t2UploadedFile?.name || '') === t2UploadName, 'T2 uploaded file name mismatch');
    assert(!Object.prototype.hasOwnProperty.call(t2UploadedFile, 'path'), 'T2 uploaded file metadata should not expose path');

    const t2CardAfter = await callLiveboards('liveboards.manage.read-card', {
      board_id: BOARD_ID,
      card_id: CHAT_CARD_ID,
    });
    const t2CardAfterData = Array.isArray(t2CardAfter?.data) ? t2CardAfter.data[0] : null;
    assert(t2CardAfterData && typeof t2CardAfterData === 'object', 'T2 post read-card returned no card');
    const t2FilesAfter = Array.isArray(t2CardAfterData?.card_data?.files)
      ? t2CardAfterData.card_data.files
      : [];
    assert(t2FilesAfter.length === t2BeforeCount + 1, `T2 expected files +1 (before=${t2BeforeCount}, after=${t2FilesAfter.length})`);

    const t2FileIndex = t2FilesAfter.findIndex((f) => String(f?.stored_name || '') === String(t2UploadedFile?.stored_name || ''));
    assert(t2FileIndex >= 0, 'T2 uploaded file metadata not found in card_data.files');
    const t2StoredFile = t2FilesAfter[t2FileIndex];
    assert(t2StoredFile?.chat === false, 'T2 stored file should be marked as card-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2StoredFile || {}, 'path'), 'T2 stored file metadata should not expose path');

    const t2DownloadRes = await callLiveboards('liveboards.inspect.file-contents', {
      board_id: BOARD_ID,
      card_id: CHAT_CARD_ID,
      file_idx: t2FileIndex,
    });
    const t2DownloadEntries = Array.isArray(t2DownloadRes) ? t2DownloadRes : [];
    const t2DownloadTextEntry = t2DownloadEntries.find((entry) => entry?.type === 'text' && typeof entry?.text === 'string');
    const t2DownloadResource = t2DownloadEntries.find((entry) => entry?.type === 'resource' && entry?.resource?.blob);
    let t2DownloadedText;
    if (t2DownloadTextEntry) {
      t2DownloadedText = t2DownloadTextEntry.text;
    } else if (t2DownloadResource && typeof t2DownloadResource?.resource?.blob === 'string') {
      t2DownloadedText = Buffer.from(t2DownloadResource.resource.blob, 'base64').toString('utf-8');
    } else {
      assert(false, 'T2 inspect.file-contents returned no text or resource blob content');
    }
    assert(t2DownloadedText === t2UploadText, 'T2 downloaded content mismatch');
    console.log('[T2] ok: upload succeeded, MCP read-card saw metadata, and MCP file-contents returned exact bytes');
  }

  // ── T3*: chat protocol over API + SSE ──
  {
    if (skipT3) {
      console.log('\n=== T3: skipped (--skip-t3) ===');
    } else {
    console.log(`\n[${new Date().toISOString()}] === T3: probe chat protocol (SSE lifecycle) ===`);
  await ensureChatSseSubscription();
  await ensureWatchpartySseSubscription();

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
      turnId: t2TurnId,
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

  const t2TurnMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2TurnId });
  assert(t2TurnMessages.length >= 3, `T3 expected at least 3 chat messages in turn, got ${t2TurnMessages.length}`);
  const t2User = t2TurnMessages.find((m) => m?.role === 'user');
  const t2InProgress = t2TurnMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
  const t2AssistantMsg = t2TurnMessages.find((m) => m?.role === 'assistant');
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

    const t2bCardAfterUpload = await readLiveCard(CHAT_CARD_ID);
    assert(t2bCardAfterUpload && typeof t2bCardAfterUpload === 'object', 'T3b card after upload read-card returned no card');
    const t2bStoredFiles = Array.isArray(t2bCardAfterUpload?.card_data?.files)
      ? t2bCardAfterUpload.card_data.files
      : [];
    const t2bStoredFile = t2bStoredFiles.find((f) => String(f?.stored_name || '') === String(uploadedFile?.stored_name || ''));
    assert(!!t2bStoredFile, 'T3b stored file metadata missing after upload');
    assert(t2bStoredFile?.chat === true, 'T3b stored file should be marked as chat-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2bStoredFile || {}, 'path'), 'T3b stored file metadata should not expose path');

    const t2bUploadMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2bTurnId });
    const t2bUploadSystem = t2bUploadMessages.find((m) => m?.role === 'system');
    assert(!!t2bUploadSystem, 'T3b upload protocol missing system chat file');
    assert(String(t2bUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3b upload system message does not describe uploaded file');
    assert(/#\d+\s*$/.test(String(t2bUploadSystem?.text || '')), 'T3b upload system message should include merged file index');
    assert(String(t2bUploadSystem?.turn || '') === t2bTurnId, 'T3b upload system turn id mismatch');

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
        turnId: t2bTurnId,
        beforeProcessing: false,
        prompt: t2bPrompt,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3b ordered lifecycle');
    assert(!!t2bLifecycle, 'T3b ordered lifecycle not observed');

    const t2bAfterMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2bTurnId });
    assert(t2bAfterMessages.length >= 3, `T3b expected at least 3 chat messages in turn, got ${t2bAfterMessages.length}`);

    const t2bUser = t2bAfterMessages.find((m) => m?.role === 'user');
    const t2bInProgress = t2bAfterMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2bAssistantMsg = t2bAfterMessages.find((m) => m?.role === 'assistant');

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

    const t2dBeforeCard = await readLiveCard(CHAT_CARD_ID);
    assert(t2dBeforeCard && typeof t2dBeforeCard === 'object', 'T3d pre card read-card returned no card');
    const t2dBeforeFiles = Array.isArray(t2dBeforeCard?.card_data?.files)
      ? t2dBeforeCard.card_data.files
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

    await waitForTurnMessages({
      cardId: CHAT_CARD_ID,
      turnId: t2dTurnId,
      timeoutMs: 60_000,
      label: 'T3d turn messages',
      predicate: (messages) => {
        const hasInProgress = messages.some((message) => message?.role === 'system' && String(message?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
        const hasAiGenerated = messages.some((message) => message?.role === 'system' && /^AI generated:/i.test(String(message?.text || '')));
        const hasAssistant = messages.some((message) => message?.role === 'assistant' && String(message?.text || '').includes(`Echo: ${t2dPrompt}`));
        return hasInProgress && hasAiGenerated && hasAssistant ? messages : false;
      },
    });

    const t2dProcessingCleared = await waitForChatPredicate((events) => {
      return events.slice(t2dEventStart).some((event) => event?.processing === false)
        ? true
        : false;
    }, 60_000, 'T3d processing clear');
    assert(!!t2dProcessingCleared, 'T3d processing did not clear');

    const t2dAfterMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2dTurnId });
    assert(t2dAfterMessages.length >= 4, `T3d expected at least 4 chat messages in turn, got ${t2dAfterMessages.length}`);

    const t2dInProgress = t2dAfterMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2dAiGenerated = t2dAfterMessages.find((m) => m?.role === 'system' && /^AI generated:/i.test(String(m?.text || '')));
    const t2dAssistantMsg = t2dAfterMessages.find((m) => m?.role === 'assistant');

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

    const t2dAfterCard = await readLiveCard(CHAT_CARD_ID);
    assert(t2dAfterCard && typeof t2dAfterCard === 'object', 'T3d post card read-card returned no card');
    const t2dAfterFiles = Array.isArray(t2dAfterCard?.card_data?.files)
      ? t2dAfterCard.card_data.files
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
      : (skipT3 ? 'T3 group skipped' : (!isTestSelected('T3A') ? 'not in --tests selection' : (!isCopilotAvailable() ? 'copilot availability not declared (set DEMO_COPILOT_AVAILABLE=1 to enable)' : 'skipped')));
    console.log(`\n=== T3a: skipped (${reason}) ===`);
  } else {
    console.log('\n=== T3a: non-probe chat protocol (expect paris) ===');
    await ensureChatSseSubscription();
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
      beforeCount: 0,
      successPattern: /paris/i,
      turnId: t2aTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3a assistant response with paris',
    });
    assert(t2aOutcome.ok, `T3a failed before assistant response: ${t2aOutcome.reason || 'unknown reason'}`);
    assert(t2aOutcome.source === 'sse', 'T3a should resolve from SSE chat notifications');

    const t2aTurnMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2aTurnId });
    assert(t2aTurnMessages.length >= 2, `T3a expected at least 2 chat messages in turn, got ${t2aTurnMessages.length}`);
    const t2aUser = t2aTurnMessages.find((m) => m?.role === 'user');
    const t2aAssistantMsg = [...t2aTurnMessages].reverse().find((m) => m?.role === 'assistant');
    assert(!!t2aUser && typeof t2aUser.id === 'string', 'T3a user chat message missing id');
    assert(String(t2aUser?.turn || '') === t2aTurnId, 'T3a user turn id mismatch');
    assert(!!t2aAssistantMsg && typeof t2aAssistantMsg.id === 'string', 'T3a assistant chat message missing id');
    assert(/paris/i.test(String(t2aAssistantMsg?.text || '')), 'T3a assistant file content missing paris');
    assert(String(t2aAssistantMsg?.turn || '') === t2aTurnId, 'T3a assistant turn id mismatch');
    for (const message of t2aTurnMessages.filter((m) => m?.role === 'system')) {
      assert(String(message?.turn || '') === t2aTurnId, 'T3a system turn id mismatch');
    }
    console.log('[T3a] ok: non-probe response contains paris');
  }

  // ── T3c: non-probe chat + file upload protocol over API + SSE ──
  if (skipT3c) {
    console.log('\n=== T3c: skipped (--skip-t3c) ===');
  } else {
    console.log('\n=== T3c: non-probe chat with file upload protocol (expect tokyo) ===');
    await ensureChatSseSubscription();
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

    const t2cCardAfterUpload = await readLiveCard(CHAT_CARD_ID);
    assert(t2cCardAfterUpload && typeof t2cCardAfterUpload === 'object', 'T3c card after upload read-card returned no card');
    const t2cStoredFiles = Array.isArray(t2cCardAfterUpload?.card_data?.files)
      ? t2cCardAfterUpload.card_data.files
      : [];
    const t2cStoredFile = t2cStoredFiles.find((f) => String(f?.stored_name || '') === String(t2cUploadedFile?.stored_name || ''));
    assert(!!t2cStoredFile, 'T3c stored file metadata missing after upload');
    assert(t2cStoredFile?.chat === true, 'T3c stored file should be marked as chat-origin');
    assert(!Object.prototype.hasOwnProperty.call(t2cStoredFile || {}, 'path'), 'T3c stored file metadata should not expose path');

    const t2cUploadMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2cTurnId });
    const t2cUploadSystem = t2cUploadMessages.find((m) => m?.role === 'system');
    assert(!!t2cUploadSystem, 'T3c upload protocol missing system chat file');
    assert(String(t2cUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3c upload system message does not describe uploaded file');
    assert(/#\d+\s*$/.test(String(t2cUploadSystem?.text || '')), 'T3c upload system message should include merged file index');
    assert(String(t2cUploadSystem?.turn || '') === t2cTurnId, 'T3c upload system turn id mismatch');

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
      beforeCount: 0,
      successPattern: /tokyo/i,
      turnId: t2cTurnId,
      timeoutMs: NON_PROBE_RESPONSE_TIMEOUT_MS,
      label: 'T3c assistant response with tokyo',
    });
    assert(t2cOutcome.ok, `T3c failed before assistant response: ${t2cOutcome.reason || 'unknown reason'}`);
    assert(t2cOutcome.source === 'sse', 'T3c should resolve from SSE chat notifications');

    const t2cTurnMessages = await readLiveCardChats(CHAT_CARD_ID, { 'turn-id': t2cTurnId });
    assert(t2cTurnMessages.length >= 2, `T3c expected at least 2 chat messages in turn, got ${t2cTurnMessages.length}`);
    const t2cUser = t2cTurnMessages.find((m) => m?.role === 'user');
    const t2cAssistantMsg = [...t2cTurnMessages].reverse().find((m) => m?.role === 'assistant');
    assert(!!t2cUser, 'T3c user chat message missing from stored chats');
    assert(String(t2cUser?.turn || '') === t2cTurnId, 'T3c user turn id mismatch');
    assert(Array.isArray(t2cUser?.files) && t2cUser.files.length === 1, 'T3c user chat message missing uploaded file metadata');
    assert(!Object.prototype.hasOwnProperty.call(t2cUser?.files?.[0] || {}, 'path'), 'T3c user chat file metadata should not expose path');
    assert(!!t2cAssistantMsg, 'T3c assistant chat message missing from SSE payload');
    assert(/tokyo/i.test(String(t2cAssistantMsg?.text || '')), 'T3c assistant file content missing tokyo');
    assert(String(t2cAssistantMsg?.turn || '') === t2cTurnId, 'T3c assistant turn id mismatch');
    console.log('[T3c] ok: non-probe file-upload response contains tokyo');
  }

  if (skipT4) {
    console.log('\n=== T4: skipped (--skip-t4) ===');
  } else {
    console.log('\n=== T4: preflight MCP smoke checks ===');

    const readTestCard = (fileName) => JSON.parse(fs.readFileSync(path.join(__dirname, 'live-cards', fileName), 'utf-8'));
    const portfolioCard = readTestCard('cardT-portfolio.json');
    const marketCard = readTestCard('cardT-market-prices.json');
    const portfolioValueCard = readTestCard('cardT-portfolio-value.json');
    const baseHoldings = Array.isArray(portfolioCard?.card_data?.holdings)
      ? deepCloneJson(portfolioCard.card_data.holdings)
      : [];

    const discoverSourceKindsData = expectLiveboardsSuccess(
      await callLiveboards('liveboards.discover.source-kinds', { board_id: BOARD_ID }),
      'T4 liveboards.discover.source-kinds',
    );
    assert(discoverSourceKindsData && typeof discoverSourceKindsData === 'object', 'T4 discover.source-kinds missing payload');
    assert(discoverSourceKindsData.sourceKinds && typeof discoverSourceKindsData.sourceKinds === 'object', 'T4 discover.source-kinds missing sourceKinds');
    const discoveredSourceKinds = Object.keys(discoverSourceKindsData.sourceKinds).sort();
    for (const requiredKind of ['urls', 'copilot', 'mcp']) {
      assert(discoveredSourceKinds.includes(requiredKind), `T4 discover.source-kinds missing ${requiredKind}: ${JSON.stringify(discoveredSourceKinds)}`);
    }
    console.log('[T4.discover] ok: required source kinds are available');

    const mockQuotes = {
      quoteResponse: {
        result: [
          { symbol: 'AAPL', shortName: 'Apple Inc.', regularMarketPrice: 198.15, regularMarketChange: 2.15, regularMarketChangePercent: 1.10 },
          { symbol: 'MSFT', shortName: 'Microsoft Corp.', regularMarketPrice: 415.32, regularMarketChange: -1.23, regularMarketChangePercent: -0.30 },
          { symbol: 'GOOGL', shortName: 'Alphabet Inc.', regularMarketPrice: 174.89, regularMarketChange: 0.89, regularMarketChangePercent: 0.51 },
          { symbol: 'TSLA', shortName: 'Tesla Inc.', regularMarketPrice: 247.12, regularMarketChange: 5.43, regularMarketChangePercent: 2.25 },
        ],
        error: null,
      },
    };

    const makePortfolioVariant = (id, extraHolding) => {
      const card = deepCloneJson(portfolioCard);
      card.id = id;
      card.card_data.holdings = [...baseHoldings, extraHolding];
      return card;
    };

    const makeMockSourceCard = ({ id, bindTo = 'quotes', secondBindTo = null, includeProjection = false }) => {
      const card = deepCloneJson(marketCard);
      card.id = id;
      card.requires = [];
      const baseSourceDef = deepCloneJson(Array.isArray(marketCard?.source_defs) ? marketCard.source_defs[0] : {});
      const firstSourceDef = {
        ...baseSourceDef,
        bindTo,
        mock: 'quotes',
      };
      const secondSourceDef = secondBindTo
        ? {
            ...deepCloneJson(baseSourceDef),
            bindTo: secondBindTo,
            mock: 'quotes',
          }
        : null;
      card.source_defs = [
        firstSourceDef,
        ...(secondSourceDef ? [secondSourceDef] : []),
      ];
      if (includeProjection) {
        card.source_defs[0].projections = { passthrough: '"ok"' };
      }
      delete card.source_defs[0].urls;
      if (card.source_defs[1]) delete card.source_defs[1].urls;
      return card;
    };

    const portfolioVariantA = makePortfolioVariant('card-portfolio-preflight-a', { ticker: 'NVDA', quantity: 7, cost_basis: 121 });
    const portfolioVariantB = makePortfolioVariant('card-portfolio-preflight-b', { ticker: 'AMD', quantity: 9, cost_basis: 143 });
    const marketMockSourceCardA = makeMockSourceCard({ id: 'card-market-prices-preflight-source-a' });
    const marketMockSourceCardB = makeMockSourceCard({ id: 'card-market-prices-preflight-source-b', includeProjection: true });
    const marketMockSourceCardC = makeMockSourceCard({ id: 'card-market-prices-preflight-source-c', secondBindTo: 'quotesBackup' });
    const marketMockSourceCardD = makeMockSourceCard({ id: 'card-market-prices-preflight-source-d', bindTo: 'quotesPrimary' });
    const marketMockSourceCardE = makeMockSourceCard({ id: 'card-market-prices-preflight-source-e', bindTo: 'quotesEcho' });

    const validateSuccessCases = [
      { name: 'portfolio live', card: portfolioCard, expectCardId: 'card-portfolio' },
      { name: 'market live', card: marketCard, expectCardId: 'card-market-prices' },
      { name: 'portfolio-value live', card: portfolioValueCard, expectCardId: 'card-portfolio-value' },
      { name: 'portfolio variant', card: portfolioVariantA, expectCardId: 'card-portfolio-preflight-a' },
      { name: 'portfolio variant B', card: portfolioVariantB, expectCardId: 'card-portfolio-preflight-b' },
    ];
    for (const tc of validateSuccessCases) {
      const body = expectLiveboardsSuccess(
        await callLiveboards('liveboards.preflight.validate-candidate-card-definition', {
          board_id: BOARD_ID,
          candidate_card_content: tc.card,
        }),
        `T4 validate success (${tc.name})`,
      );
      assert(body.cardId === tc.expectCardId, `T4 validate ${tc.name} cardId mismatch`);
      assert(body.isValid === true, `T4 validate ${tc.name} expected isValid=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 validate ${tc.name} expected no issues`);
      console.log(`[T4.validate] ok: ${tc.name}`);
    }

    const materializeSuccessCases = [
      {
        name: 'portfolio live empty mocks',
        card: portfolioCard,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length, 'T4 materialize portfolio holdings length mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 materialize portfolio rendered_view mismatch');
        },
      },
      {
        name: 'portfolio variant with extra holding',
        card: portfolioVariantA,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio variant holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 materialize portfolio variant holdings length mismatch');
        },
      },
      {
        name: 'portfolio variant B with extra holding',
        card: portfolioVariantB,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio variant B holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 materialize portfolio variant B holdings length mismatch');
        },
      },
      {
        name: 'portfolio-value live with mock requires',
        card: portfolioValueCard,
        mockRequires: { holdings: baseHoldings, quotes: mockQuotes },
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.computed_values?.positions) && body.computed_values.positions.length > 0, 'T4 materialize portfolio-value positions missing');
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length > 0, 'T4 materialize portfolio-value provides missing');
          assert(body.rendered_view?.elements?.length === 3, 'T4 materialize portfolio-value rendered_view length mismatch');
        },
      },
      {
        name: 'portfolio-value subset requires',
        card: portfolioValueCard,
        mockRequires: {
          holdings: baseHoldings.slice(0, 2),
          quotes: { quoteResponse: { result: mockQuotes.quoteResponse.result.slice(0, 2), error: null } },
        },
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.computed_values?.positions) && body.computed_values.positions.length === 2, 'T4 materialize portfolio-value subset positions mismatch');
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length === 2, 'T4 materialize portfolio-value subset provides mismatch');
        },
      },
    ];
    for (const tc of materializeSuccessCases) {
      const body = expectLiveboardsSuccess(
        await callLiveboards('liveboards.preflight.materialize-candidate-card', {
          board_id: BOARD_ID,
          candidate_card_content: tc.card,
          mock_requires: tc.mockRequires,
          mock_fetched_sources: tc.mockFetchedSources,
        }),
        `T4 materialize success (${tc.name})`,
      );
      assert(body.ok === true, `T4 materialize ${tc.name} expected ok=true`);
      assert(Array.isArray(body.errors) && body.errors.length === 0, `T4 materialize ${tc.name} expected no errors`);
      tc.verify(body);
      console.log(`[T4.materialize] ok: ${tc.name}`);
    }

    const probeSuccessCases = [
      { name: 'single mock source base', card: marketMockSourceCardA, sourceIdx: 0, bindTo: 'quotes', mockProjections: {} },
      { name: 'single mock source with projection payload', card: marketMockSourceCardB, sourceIdx: 0, bindTo: 'quotes', mockProjections: { passthrough: 'ok' } },
      { name: 'two mock sources first entry', card: marketMockSourceCardC, sourceIdx: 0, bindTo: 'quotes', mockProjections: {} },
      { name: 'two mock sources second entry', card: marketMockSourceCardC, sourceIdx: 1, bindTo: 'quotesBackup', mockProjections: {} },
      { name: 'single mock source alternate bindTo', card: marketMockSourceCardD, sourceIdx: 0, bindTo: 'quotesPrimary', mockProjections: {} },
    ];
    for (const tc of probeSuccessCases) {
      const body = expectLiveboardsSuccess(
        await callLiveboards('liveboards.preflight.probe-single-source-in-candidate-card', {
          board_id: BOARD_ID,
          candidate_card_content: tc.card,
          source_idx: tc.sourceIdx,
          mock_projections: tc.mockProjections,
        }),
        `T4 probe success (${tc.name})`,
      );
      assert(body.bindTo === tc.bindTo, `T4 probe ${tc.name} bindTo mismatch`);
      assert(body.reachable === true, `T4 probe ${tc.name} expected reachable=true`);
      assert(typeof body.latencyMs === 'number', `T4 probe ${tc.name} expected numeric latencyMs`);
      console.log(`[T4.probe] ok: ${tc.name}`);
    }

    const runSourceSuccessCases = [
      { name: 'single mock source base', card: marketMockSourceCardA, sourceIdx: 0, bindTo: 'quotes' },
      { name: 'single mock source with projection payload', card: marketMockSourceCardB, sourceIdx: 0, bindTo: 'quotes' },
      { name: 'two mock sources first entry', card: marketMockSourceCardC, sourceIdx: 0, bindTo: 'quotes' },
      { name: 'two mock sources second entry', card: marketMockSourceCardC, sourceIdx: 1, bindTo: 'quotesBackup' },
      { name: 'single mock source alternate bindTo', card: marketMockSourceCardE, sourceIdx: 0, bindTo: 'quotesEcho' },
    ];
    for (const tc of runSourceSuccessCases) {
      const body = expectLiveboardsSuccess(
        await callLiveboards('liveboards.preflight.run-single-source-in-candidate-card', {
          board_id: BOARD_ID,
          candidate_card_content: tc.card,
          source_idx: tc.sourceIdx,
          mock_projections: {},
        }),
        `T4 run-source success (${tc.name})`,
      );
      assert(body.bindTo === tc.bindTo, `T4 run-source ${tc.name} bindTo mismatch`);
      assert(body.ok === true, `T4 run-source ${tc.name} expected ok=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 run-source ${tc.name} expected no issues`);
      assert(Array.isArray(body.result?.quoteResponse?.result) && body.result.quoteResponse.result.length > 0, `T4 run-source ${tc.name} result shape mismatch`);
      console.log(`[T4.run-source] ok: ${tc.name}`);
    }

    const liveRunCardId = String(marketCard?.id || 'card-market-prices');
    const liveRunSourceBody = expectLiveboardsSuccess(
      await callLiveboards('liveboards.preflight.run-single-source-in-live-card', {
        board_id: BOARD_ID,
        card_id: liveRunCardId,
        source_idx: 0,
        mock_requires: { holdings: baseHoldings },
      }),
      'T4 run-source live card success',
    );
    assert(liveRunSourceBody.bindTo === 'quotes', 'T4 run-source live card bindTo mismatch');
    assert(liveRunSourceBody.ok === true, 'T4 run-source live card expected ok=true');
    assert(Array.isArray(liveRunSourceBody.issues) && liveRunSourceBody.issues.length === 0, 'T4 run-source live card expected no issues');
    assert(Array.isArray(liveRunSourceBody.result) && liveRunSourceBody.result.length === baseHoldings.length, 'T4 run-source live card result shape mismatch');
    console.log('[T4.run-source-live] ok: live card source run returns candidate-compatible shape');

    const liveRunRequiresBody = expectLiveboardsSuccess(
      await callLiveboards('liveboards.preflight.run-single-source-in-live-card', {
        board_id: BOARD_ID,
        card_id: liveRunCardId,
        source_idx: 0,
        mock_requires: { holdings: baseHoldings },
      }),
      'T4 run-source live card uses mock_requires in projections',
    );
    assert(liveRunRequiresBody.bindTo === 'quotes', 'T4 run-source live card requires bindTo mismatch');
    assert(liveRunRequiresBody.ok === true, 'T4 run-source live card requires expected ok=true');
    assert(Array.isArray(liveRunRequiresBody.issues) && liveRunRequiresBody.issues.length === 0, 'T4 run-source live card requires expected no issues');
    assert(Array.isArray(liveRunRequiresBody.result) && liveRunRequiresBody.result.length === baseHoldings.length, 'T4 run-source live card requires result shape mismatch');
    console.log('[T4.run-source-live] ok: non-empty mock_requires is consumed via source projections');

    const runCycleSuccessCases = [
      {
        name: 'portfolio live',
        card: portfolioCard,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length, 'T4 run-cycle portfolio provides mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 run-cycle portfolio rendered_view mismatch');
        },
      },
      {
        name: 'portfolio variant',
        card: portfolioVariantB,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 run-cycle portfolio variant provides mismatch');
        },
      },
      {
        name: 'portfolio variant B',
        card: portfolioVariantB,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 run-cycle portfolio variant B provides mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 run-cycle portfolio variant B rendered_view mismatch');
        },
      },
      {
        name: 'portfolio-value with full requires',
        card: portfolioValueCard,
        mockRequires: { holdings: baseHoldings, quotes: mockQuotes },
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length > 0, 'T4 run-cycle portfolio-value provides mismatch');
          assert(body.rendered_view?.elements?.length === 3, 'T4 run-cycle portfolio-value rendered_view mismatch');
        },
      },
      {
        name: 'portfolio-value subset requires',
        card: portfolioValueCard,
        mockRequires: {
          holdings: baseHoldings.slice(0, 2),
          quotes: { quoteResponse: { result: mockQuotes.quoteResponse.result.slice(0, 2), error: null } },
        },
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length === 2, 'T4 run-cycle portfolio-value subset length mismatch');
        },
      },
      {
        name: 'market-prices with live source simulation',
        card: marketCard,
        mockRequires: { holdings: baseHoldings.slice(0, 3) },
        verify: (body) => {
          const quoteRows = body.provides_outputs?.quotes?.quoteResponse?.result;
          assert(Array.isArray(quoteRows) && quoteRows.length === 3, 'T4 run-cycle market-prices provides result length mismatch');
          assert(typeof quoteRows[0]?.symbol === 'string' && quoteRows[0].symbol.length > 0, 'T4 run-cycle market-prices provides symbol missing');

          const resolvedRows = body.rendered_view?.elements?.[0]?.resolved;
          assert(Array.isArray(resolvedRows) && resolvedRows.length === 3, 'T4 run-cycle market-prices rendered resolved length mismatch');
          assert(typeof resolvedRows[0]?.ticker === 'string' && resolvedRows[0].ticker.length > 0, 'T4 run-cycle market-prices rendered ticker missing');
          assert(typeof resolvedRows[0]?.price === 'number', 'T4 run-cycle market-prices rendered price missing');
        },
      },
    ];
    for (const tc of runCycleSuccessCases) {
      const body = expectLiveboardsSuccess(
        await callLiveboards('liveboards.preflight.run-one-cycle-with-candidate-card', {
          board_id: BOARD_ID,
          candidate_card_content: tc.card,
          mock_requires: tc.mockRequires,
        }),
        `T4 run-cycle success (${tc.name})`,
      );
      assert(body.ok === true, `T4 run-cycle ${tc.name} expected ok=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 run-cycle ${tc.name} expected no issues`);
      tc.verify(body);
      console.log(`[T4.run-cycle] ok: ${tc.name}`);
    }

    console.log('\n[T4.remove-card] testing liveboards.manage.remove-card lifecycle');
    const t4RemoveCardId = 'card-t4-remove-test';
    const t4RemoveCardV1 = {
      id: t4RemoveCardId,
      card_data: { label: 'v1', color: 'blue' },
    };
    const t4RemoveCardV2 = {
      id: t4RemoveCardId,
      card_data: { label: 'v2', color: 'red' },
    };

    const t4UpsertV1Data = expectLiveboardsSuccess(
      await callLiveboards('liveboards.manage.upsert-card', {
        board_id: BOARD_ID,
        card_id: t4RemoveCardId,
        candidate_card_content: t4RemoveCardV1,
      }),
      'T4.remove-card v1 upsert',
    );
    assert(t4UpsertV1Data?.board_result?.status === 'success', 'T4.remove-card v1 upsert board_result expected success');
    console.log('[T4.remove-card] ok: v1 card upserted');

    const t4StatusBeforeRemove = expectLiveboardsSuccess(
      await callLiveboards('liveboards.inspect.board-runtime-status', { board_id: BOARD_ID }),
      'T4.remove-card board-runtime-status before remove',
    );
    const t4CardsBefore = Array.isArray(t4StatusBeforeRemove?.cards) ? t4StatusBeforeRemove.cards : [];
    assert(t4CardsBefore.some((card) => card['card-id'] === t4RemoveCardId), 'T4.remove-card card missing before remove');
    const t4CardCountBefore = t4StatusBeforeRemove?.summary?.card_count ?? 0;

    const t4RemoveData = expectLiveboardsSuccess(
      await callLiveboards('liveboards.manage.remove-card', {
        board_id: BOARD_ID,
        card_id: t4RemoveCardId,
      }),
      'T4.remove-card remove',
    );
    assert(t4RemoveData?.board_result?.status === 'success', 'T4.remove-card board_result expected success');
    assert(t4RemoveData?.store_result?.status === 'success', 'T4.remove-card store_result expected success');
    console.log('[T4.remove-card] ok: manage.remove-card returned success for both board and store');

    await sleep(2_000);

    const t4StatusAfterRemove = expectLiveboardsSuccess(
      await callLiveboards('liveboards.inspect.board-runtime-status', { board_id: BOARD_ID }),
      'T4.remove-card board-runtime-status after remove',
    );
    const t4CardsAfter = Array.isArray(t4StatusAfterRemove?.cards) ? t4StatusAfterRemove.cards : [];
    assert(!t4CardsAfter.some((card) => card['card-id'] === t4RemoveCardId), 'T4.remove-card card still present after remove');
    const t4CardCountAfter = t4StatusAfterRemove?.summary?.card_count ?? 0;
    assert(t4CardCountAfter === t4CardCountBefore - 1, `T4.remove-card card_count expected ${t4CardCountBefore - 1}, got ${t4CardCountAfter}`);
    console.log(`[T4.remove-card] ok: card absent from board-runtime-status after remove (count: ${t4CardCountBefore} -> ${t4CardCountAfter})`);

    const t4UpsertV2Data = expectLiveboardsSuccess(
      await callLiveboards('liveboards.manage.upsert-card', {
        board_id: BOARD_ID,
        card_id: t4RemoveCardId,
        candidate_card_content: t4RemoveCardV2,
      }),
      'T4.remove-card v2 upsert',
    );
    assert(t4UpsertV2Data?.board_result?.status === 'success', 'T4.remove-card v2 upsert board_result expected success');

    await waitForAllCompleted(30_000, 'T4 remove-card re-upsert completion');

    const t4StatusAfterV2 = expectLiveboardsSuccess(
      await callLiveboards('liveboards.inspect.board-runtime-status', { board_id: BOARD_ID }),
      'T4.remove-card board-runtime-status after v2 upsert',
    );
    const t4CardsAfterV2 = Array.isArray(t4StatusAfterV2?.cards) ? t4StatusAfterV2.cards : [];
    assert(t4CardsAfterV2.some((card) => card['card-id'] === t4RemoveCardId), 'T4.remove-card v2 card missing from board-runtime-status');
    const t4CardCountAfterV2 = t4StatusAfterV2?.summary?.card_count ?? 0;
    assert(t4CardCountAfterV2 === t4CardCountBefore, `T4.remove-card card_count after v2 upsert expected ${t4CardCountBefore}, got ${t4CardCountAfterV2}`);

    const t4ReadBack = await readCardDefinitionAndRuntimeViaLiveboards(t4RemoveCardId);
    const t4ReadBackCard = t4ReadBack?.card_definition_and_static_data ?? null;
    assert(t4ReadBackCard?.card_data?.label === 'v2', 'T4.remove-card v2 readback label mismatch');
    assert(t4ReadBackCard?.card_data?.color === 'red', 'T4.remove-card v2 readback color mismatch');
    console.log('[T4.remove-card] ok: same card id can be re-added with new content after remove');

    const t4CleanupRemove = expectLiveboardsSuccess(
      await callLiveboards('liveboards.manage.remove-card', {
        board_id: BOARD_ID,
        card_id: t4RemoveCardId,
      }),
      'T4.remove-card cleanup remove',
    );
    assert(t4CleanupRemove?.board_result?.status === 'success', 'T4.remove-card cleanup board_result expected success');
    assert(t4CleanupRemove?.store_result?.status === 'success', 'T4.remove-card cleanup store_result expected success');
    await sleep(2_000);

    const t4StatusAfterCleanup = expectLiveboardsSuccess(
      await callLiveboards('liveboards.inspect.board-runtime-status', { board_id: BOARD_ID }),
      'T4.remove-card board-runtime-status after cleanup',
    );
    const t4CardsAfterCleanup = Array.isArray(t4StatusAfterCleanup?.cards) ? t4StatusAfterCleanup.cards : [];
    assert(!t4CardsAfterCleanup.some((card) => card['card-id'] === t4RemoveCardId), 'T4.remove-card cleanup card still present after final remove');
    console.log('[T4.remove-card] ok: temporary test card cleaned up');
  }
  }

  console.log('\n=== All smoke checks passed ===\n');
  runCompletedSuccessfully = true;
} finally {
  if (chatSseClientId) {
    try {
      if (watchpartySubscribed) {
        await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/watch-channel/${AGENT_OUTPUT_CHANNEL}/unsubscribe-sse`, { clientId: chatSseClientId });
      }
    } catch { /* ignore */ }
    try {
      await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/unsubscribe-sse`, { clientId: chatSseClientId });
    } catch { /* ignore */ }
  }
  if (chatSseClient) chatSseClient.close();
  await closeMcpClient();
  if (sseWorker) await sseWorker.terminate();
}
