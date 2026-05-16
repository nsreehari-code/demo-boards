#!/usr/bin/env node
/**
 * demo-http-test.js
 *
 * Smoke test for demo-board/demo-server.js over HTTP + SSE.
 * Targets the 'live' board with --cards-pattern cardT* to load only the 3
 * test cards (cardT-portfolio, cardT-market-prices, cardT-portfolio-value).
 *
 * T0: init-board → SSE initial payload → wait for all cards to complete
 * T1: PATCH holdings (+1 row) → verify recomputation (holdings +1, positions +1)
 *
 * Usage:
 *   node test/demo-http-test.js [--port 7799]
 */

import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
const portArg = cliArgs.indexOf('--port');
const cliPort = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : NaN;
const RUN_ID = `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const BOARD_ID = 'live';
const SERVER_SCRIPT = path.resolve(__dirname, '..', 'demo-server.js');
const SERVER_DIR = path.dirname(SERVER_SCRIPT);
const SSE_WORKER_SCRIPT = path.join(__dirname, 'sse-worker.js');
const CARD_PATTERN = 'cardT*';
const CHAT_CARD_ID = 'card-portfolio';

function resolveServerPort() {
  if (Number.isInteger(cliPort) && cliPort > 0) return cliPort;
  const configPath = path.join(SERVER_DIR, 'server-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const configured = Number(cfg?.port);
    if (Number.isInteger(configured) && configured > 0) return configured;
  } catch { /* ignore */ }
  return 7799;
}

const PORT = resolveServerPort();
const BASE = `http://127.0.0.1:${PORT}/api/boards/${BOARD_ID}`;

// Resolve and wipe the setup directory so each test run starts clean.
function resolveSetupDirRoot() {
  const configPath = path.join(SERVER_DIR, 'server-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg && typeof cfg.setupDir === 'string' && cfg.setupDir.trim()) {
      return path.resolve(SERVER_DIR, cfg.setupDir.trim());
    }
  } catch { /* ignore */ }
  return path.join(SERVER_DIR, '.demo-setup');
}

const SETUP_DIR = path.join(resolveSetupDirRoot(), RUN_ID);
const BOARD_SETUP_ROOT = path.join(SETUP_DIR, 'boards');
if (fs.existsSync(SETUP_DIR)) {
  fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  console.log(`[demo-http-test] wiped setup dir: ${SETUP_DIR}`);
}

// ---------------------------------------------------------------------------
// Shared state — accumulated from SSE frames
// ---------------------------------------------------------------------------

const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
  chatEvents: [],
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

function assert(condition, message) {
  if (!condition) {
    console.error(`\n[ASSERT FAILED] ${message}`);
    process.exit(1);
  }
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

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        DEMO_SERVER_PORT: String(port),
        DEMO_SETUP_DIR: SETUP_DIR,
        DEMO_BOARD_SETUP_ROOT: BOARD_SETUP_ROOT,
        DEMO_CARDS_PATTERN: CARD_PATTERN,
      },
    });
    let ready = false;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      process.stdout.write(`[server] ${text}`);
      if (!ready && text.includes('listening on')) {
        ready = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited early: code ${code}`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Server startup timeout (15s)'));
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// Test sequence
// ---------------------------------------------------------------------------

console.log('\n=== live board HTTP+SSE smoke test ===');
console.log(`target: ${BASE}`);
console.log(`card pattern: ${CARD_PATTERN}`);

const serverProc = await startServer(PORT);
let sseWorker = null;
let chatSseClient = null;
let chatSseClientId = '';

try {
  // ── T0: init-board, SSE connect, wait for initial completion ──

  // Register the 'live' board via POST (v8 runtime requires explicit registration)
  const regRes = await httpJson('POST', `http://127.0.0.1:${PORT}/api/boards`, { id: BOARD_ID, label: 'Live' });
  assert(regRes.status === 200 || regRes.status === 201 || regRes.status === 409,
    `POST /api/boards returned ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  console.log(`[setup] board '${BOARD_ID}' registered (${regRes.status})`);

  console.log('\n=== T0 Step 1: init-board ===');
  const initRes = await httpGet(`${BASE}/init-board`);
  assert(initRes.status === 200, `init-board returned ${initRes.status}`);
  console.log('[T0.1] init-board ok');

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

  // ── T2: probe chat protocol over API + SSE ──
  console.log('\n=== T2: probe chat protocol (SSE lifecycle) ===');
  chatSseClientId = `chat-proto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  chatSseClient = startSseClient(`${BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}`, (payload) => {
    captureChatEvents(payload, CHAT_CARD_ID);
  });
  await new Promise((r) => setTimeout(r, 400));

  const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/subscribe-sse`, { clientId: chatSseClientId });
  assert(subRes.status === 200, `chat subscribe returned ${subRes.status}`);

  const t2Before = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats`);
  assert(t2Before.status === 200, `T2 pre chats returned ${t2Before.status}`);
  const t2BeforeMessages = Array.isArray(t2Before.data?.messages) ? t2Before.data.messages : [];
  const t2BeforeCount = t2BeforeMessages.length;
  const t2ProbePrompt = `Probe protocol validation ${Date.now()}`;

  const t2SendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
    actionType: 'chat-send',
    payload: {
      text: JSON.stringify({
        prompt: t2ProbePrompt,
        probe: true,
        chatTimeMs: 2200,
        chatTimeoutMs: 20000,
      }),
    },
  });
  assert(t2SendRes.status === 200, `T2 chat-send returned ${t2SendRes.status}`);

  const t2UserOrProcessing = await waitForChatPredicate((events) => {
    const slice = events.filter((e) => e.messageCount >= t2BeforeCount + 1 || e.processing === true);
    return slice.length > 0 ? slice[slice.length - 1] : false;
  }, 30_000, 'T2 user/proc signal');
  assert(!!t2UserOrProcessing, 'T2 missing user/proc signal');

  const t2Assistant = await waitForChatPredicate((events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.messageCount < t2BeforeCount + 2) continue;
      const last = e.messages[e.messages.length - 1];
      if (last?.role === 'assistant' && String(last.text || '').includes(`Echo: ${t2ProbePrompt}`)) {
        return e;
      }
    }
    return false;
  }, 45_000, 'T2 assistant echo');
  assert(!!t2Assistant, 'T2 assistant echo not observed on SSE');

  const t2ProcessingCleared = await waitForChatPredicate((events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.messageCount >= t2BeforeCount + 2 && e.processing === false) return e;
    }
    return false;
  }, 30_000, 'T2 processing clear');
  assert(!!t2ProcessingCleared, 'T2 processing clear not observed');

  const t2After = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats`);
  assert(t2After.status === 200, `T2 post chats returned ${t2After.status}`);
  const t2AfterMessages = Array.isArray(t2After.data?.messages) ? t2After.data.messages : [];
  const t2NewMessages = t2AfterMessages.slice(t2BeforeCount);
  assert(t2NewMessages.length >= 2, `T2 expected at least 2 new chat files, got ${t2NewMessages.length}`);
  const t2User = t2NewMessages.find((m) => m?.role === 'user');
  const t2AssistantMsg = t2NewMessages.find((m) => m?.role === 'assistant');
  assert(!!t2User && /\d{3}_user\.txt$/i.test(String(t2User.stored_name || '')), 'T2 user file naming mismatch');
  assert(String(t2User?.text || '').includes(t2ProbePrompt), 'T2 user file text mismatch');
  assert(!!t2AssistantMsg && /\d{3}_assistant\.txt$/i.test(String(t2AssistantMsg.stored_name || '')), 'T2 assistant file naming mismatch');
  assert(String(t2AssistantMsg?.text || '').includes(`Echo: ${t2ProbePrompt}`), 'T2 assistant echo file content mismatch');
  console.log('[T2] ok: probe lifecycle observed (processing/user any-order, assistant write, processing clear)');

  // ── T2a: non-probe chat protocol over API + SSE ──
  console.log('\n=== T2a: non-probe chat protocol (expect paris) ===');
  const t2aBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats`);
  assert(t2aBefore.status === 200, `T2a pre chats returned ${t2aBefore.status}`);
  const t2aBeforeMessages = Array.isArray(t2aBefore.data?.messages) ? t2aBefore.data.messages : [];
  const t2aBeforeCount = t2aBeforeMessages.length;
  const t2aPrompt = 'Just answer what is the capital of France. No Fluff. No COmmentary.  No Markup Respond in lower case in one word.';

  const t2aSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
    actionType: 'chat-send',
    payload: {
      text: JSON.stringify({
        prompt: t2aPrompt,
        probe: false,
        chatTimeoutMs: 180000,
      }),
    },
  });
  assert(t2aSendRes.status === 200, `T2a chat-send returned ${t2aSendRes.status}`);

  const t2aAssistant = await waitForChatPredicate((events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.messageCount < t2aBeforeCount + 2) continue;
      const last = e.messages[e.messages.length - 1];
      if (last?.role === 'assistant' && /paris/i.test(String(last.text || ''))) return e;
    }
    return false;
  }, 240_000, 'T2a assistant response with paris');
  assert(!!t2aAssistant, 'T2a assistant response with paris not observed on SSE');

  const t2aAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats`);
  assert(t2aAfter.status === 200, `T2a post chats returned ${t2aAfter.status}`);
  const t2aAfterMessages = Array.isArray(t2aAfter.data?.messages) ? t2aAfter.data.messages : [];
  const t2aNewMessages = t2aAfterMessages.slice(t2aBeforeCount);
  assert(t2aNewMessages.length >= 2, `T2a expected at least 2 new chat files, got ${t2aNewMessages.length}`);
  const t2aAssistantMsg = [...t2aNewMessages].reverse().find((m) => m?.role === 'assistant');
  assert(!!t2aAssistantMsg && /\d{3}_assistant\.txt$/i.test(String(t2aAssistantMsg.stored_name || '')), 'T2a assistant file naming mismatch');
  assert(/paris/i.test(String(t2aAssistantMsg?.text || '')), 'T2a assistant file content missing paris');
  console.log('[T2a] ok: non-probe response contains paris');

  console.log('\n=== All smoke checks passed ===\n');
} finally {
  if (chatSseClientId) {
    try {
      await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/unsubscribe-sse`, { clientId: chatSseClientId });
    } catch { /* ignore */ }
  }
  if (chatSseClient) chatSseClient.close();
  serverProc.kill();
  await new Promise((r) => serverProc.on('exit', r));
  if (sseWorker) await sseWorker.terminate();

  // Clean up the test setup directory
  if (fs.existsSync(SETUP_DIR)) {
    fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  }
  console.log('[demo-http-test] server stopped, setup dir cleaned');
}
