#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from 'yaml-flow/board-live-cards-server-runtime';

import {
  createFsBoardPlatformAdapter,
  createFsBoardChatStorage,
  createNodeSpawnInvocationAdapter,
  createArtifactsStore,
  invokeExecutionRef,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';
import {
  createStepMachineChatFlowRunner,
} from 'yaml-flow/step-machine-public';

const __filename = fileURLToPath(import.meta.url);
const SERVER_DIR = path.dirname(__filename);
const BOARD_ROOT = path.resolve(SERVER_DIR, '..');
const cliArgs = process.argv.slice(2);
const SERVER_CONFIG = path.join(BOARD_ROOT, 'server-config.json');

function loadServerConfig() {
  const cliConfigIndex = cliArgs.indexOf('--config');
  const cliConfigPath = cliConfigIndex !== -1 ? cliArgs[cliConfigIndex + 1] : '';
  const configuredPath = String(cliConfigPath || '').trim();
  const configPath = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(BOARD_ROOT, configuredPath))
    : SERVER_CONFIG;
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveFromConfig(configValue) {
  if (typeof configValue !== 'string' || !configValue.trim()) return null;
  return path.resolve(BOARD_ROOT, configValue);
}

function normalizeSetupPath(configValue, fallbackValue) {
  if (typeof configValue !== 'string') return fallbackValue;
  const normalized = configValue.trim();
  return normalized || fallbackValue;
}

function resolveBoardSetupPaths(cfg, boardId, boardSetupRootOverride) {
  const legacySetupRoot = cfg?.setupDir
    ? path.resolve(BOARD_ROOT, cfg.setupDir)
    : path.join(setupDir, `board-${boardId}`);
  const setupCfg = cfg?.setup && typeof cfg.setup === 'object' ? cfg.setup : {};
  const setupRoot = boardSetupRootOverride
    ? path.resolve(boardSetupRootOverride, `board-${boardId}`)
    : (resolveFromConfig(setupCfg.setupRoot) || legacySetupRoot);

  const leaves = {
    boardRuntime:      normalizeSetupPath(setupCfg.boardRuntime,      'runtime'),
    boardOutputsStore: normalizeSetupPath(setupCfg.boardOutputsStore, 'board-outputs'),
    cardStore:         normalizeSetupPath(setupCfg.cardStore,         'cards-store'),
    artifactsStore:    normalizeSetupPath(setupCfg.artifactsStore,    'cards-files'),
    chatStore:         normalizeSetupPath(setupCfg.chatStore,         'cards-chats'),
    scratchStore:      normalizeSetupPath(setupCfg.scratchStore,      'scratch'),
    archivalStore:     normalizeSetupPath(setupCfg.archivalStore,     'runtime-archive'),
  };
  const toAbs = (leaf) => (path.isAbsolute(leaf) ? leaf : path.resolve(setupRoot, leaf));

  return {
    setupRoot,
    ...leaves,
    boardRuntimePath:      toAbs(leaves.boardRuntime),
    boardOutputsStorePath: toAbs(leaves.boardOutputsStore),
    cardStorePath:         toAbs(leaves.cardStore),
    artifactsStorePath:    toAbs(leaves.artifactsStore),
    chatStorePath:         toAbs(leaves.chatStore),
    scratchStorePath:      toAbs(leaves.scratchStore),
    archivalStorePath:     toAbs(leaves.archivalStore),
  };
}

function loadJsonFromConfig(configValue) {
  const resolved = resolveFromConfig(configValue);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeTimeoutMs(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizePrestartCommands(configValue) {
  if (!Array.isArray(configValue)) return [];
  return configValue
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function runPrestartCommands(commands) {
  for (const command of commands) {
    console.log(`[board-server] prestart: ${command}`);
    await new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: BOARD_ROOT,
        stdio: 'inherit',
        shell: true,
        windowsHide: true,
      });

      child.on('error', (err) => {
        reject(new Error(`Prestart command failed to launch: ${command}\n${String(err?.message || err)}`));
      });

      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        if (signal) {
          reject(new Error(`Prestart command terminated by signal ${signal}: ${command}`));
          return;
        }
        reject(new Error(`Prestart command exited with code ${code}: ${command}`));
      });
    });
  }
}

function pickTimeoutMs(...values) {
  for (const value of values) {
    const n = normalizeTimeoutMs(value, null);
    if (n !== null) return n;
  }
  return null;
}

function applyFlowTimeout(flow, timeoutMs) {
  if (!flow || typeof flow !== 'object') return flow;
  const normalized = normalizeTimeoutMs(timeoutMs, null);
  if (normalized === null) return flow;
  return {
    ...flow,
    settings: {
      ...(flow.settings && typeof flow.settings === 'object' ? flow.settings : {}),
      timeout_ms: normalized,
    },
  };
}

function buildChatHandlerFlowFromScript(scriptPath, timeoutMs = null) {
  if (!scriptPath) return null;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(BOARD_ROOT, scriptPath);
  const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs, 300000);
  return {
    id: 'demo-chat-script-handler',
    settings: { start_step: 'respond', max_total_steps: 5, timeout_ms: resolvedTimeoutMs },
    steps: {
      respond: {
        description: 'Run the demo board chat responder from a script path',
        handler: {
          type: 'ref',
          howToRun: 'local-node',
          whatToRun: { kind: 'fs-path', value: resolved },
          meta: 'chat-handler',
        },
        transitions: { success: 'completed', failure: 'failed' },
      },
    },
    terminal_states: {
      completed: { description: 'Chat response completed', return_intent: 'success', return_artifacts: false },
      failed: { description: 'Chat response failed', return_intent: 'failure', return_artifacts: false },
    },
  };
}

const serverConfig = loadServerConfig();
const configuredChatFlowTimeoutMs = normalizeTimeoutMs(serverConfig.chatFlowTimeoutMs, null);
const configuredInvokeRefTimeoutMs = normalizeTimeoutMs(serverConfig.chatInvokeRefTimeoutMs, 300000);
const configuredCopilotTimeoutMs = normalizeTimeoutMs(serverConfig.chatCopilotTimeoutMs, 300000);

// Resolve top-level config defaults (used as fallbacks for per-board config)
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath);
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredFlowFromPath = loadJsonFromConfig(serverConfig.chatHandlerFlowPath);
const configuredChatHandlerFlow = applyFlowTimeout(
  configuredFlowFromPath || buildChatHandlerFlowFromScript(configuredChatHandlerPath, configuredChatFlowTimeoutMs),
  configuredChatFlowTimeoutMs,
);
const configuredInferenceAdapterPath = resolveFromConfig(serverConfig.inferenceAdapterPath);
const configuredStepMachineCliPath = resolveFromConfig(serverConfig.stepMachineCliPath);

if (!process.env.DEMO_STEP_MACHINE_CLI_PATH && configuredStepMachineCliPath) {
  process.env.DEMO_STEP_MACHINE_CLI_PATH = configuredStepMachineCliPath;
}
if (!process.env.DEMO_CHAT_HANDLER_PATH && configuredChatHandlerPath) {
  process.env.DEMO_CHAT_HANDLER_PATH = configuredChatHandlerPath;
}
if (!process.env.DEMO_INFERENCE_ADAPTER_PATH && configuredInferenceAdapterPath) {
  process.env.DEMO_INFERENCE_ADAPTER_PATH = configuredInferenceAdapterPath;
}

const PORT = Number(process.env.DEMO_SERVER_PORT || serverConfig.port || 7799);
const cardsPatternArgIndex = cliArgs.indexOf('--cards-pattern');
const cliCardsPattern = cardsPatternArgIndex !== -1 ? cliArgs[cardsPatternArgIndex + 1] : null;
const selectedCardsPattern = (process.env.DEMO_CARDS_PATTERN || cliCardsPattern || '').trim() || null;
const prestartCommands = normalizePrestartCommands(serverConfig.prestart);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

// ---------------------------------------------------------------------------
// Setup directory
// ---------------------------------------------------------------------------

const setupDir = path.resolve(
  process.env.DEMO_SETUP_DIR || path.join(BOARD_ROOT, '.demo-setup'),
);
fs.mkdirSync(setupDir, { recursive: true });

// ---------------------------------------------------------------------------
// Host adapter factories — Node-specific implementations injected into the
// platform-free server runtime.
// ---------------------------------------------------------------------------

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function createFsCardSource(cardsDir, cardPattern = null) {
  const cardRegex = cardPattern ? wildcardToRegExp(cardPattern) : null;
  return {
    listCards() {
      if (!fs.existsSync(cardsDir)) return [];
      return fs.readdirSync(cardsDir)
        .filter(f => {
          if (!f.endsWith('.json')) return false;
          if (!cardRegex) return true;
          const cardId = path.basename(f, '.json');
          return cardRegex.test(cardId);
        })
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf-8')); }
          catch { return null; }
        })
        .filter(Boolean);
    },
  };
}

function namedPipePath(pipeName) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

function makeExecutionRef(scriptPath, extra) {
  if (!scriptPath) return undefined;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  return {
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: resolved }),
    ...(extra !== undefined ? { meta: extra } : {}),
  };
}

function createNamedPipeNotificationTransport() {
  return {
    async subscribe(ref, onEvent) {
      if (ref.kind !== 'named-pipe') return () => {};
      const pipePath = ref.value;
      if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
        try { fs.rmSync(pipePath, { force: true }); } catch { /* */ }
      }
      const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf-8');
          while (true) {
            const i = buf.indexOf('\n');
            if (i < 0) break;
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try { onEvent(JSON.parse(line)?.notification ?? JSON.parse(line)); } catch { /* */ }
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => resolve());
      });
      return () => {
        server.close();
        if (process.platform !== 'win32') {
          try { fs.rmSync(pipePath, { force: true }); } catch { /* */ }
        }
      };
    },
  };
}

function createConfigBackedServerMetaStore(entries) {
  const store = new Map();
  const boards = entries.map(([id, cfg]) => ({ id, label: cfg?.label || id }));
  store.set('boards-config.json', JSON.stringify({ boards }, null, 2));
  for (const [id, cfg] of entries) {
    store.set(`boards/${id}.json`, JSON.stringify({ id, label: cfg?.label || id }));
  }
  return {
    getText(key) {
      return store.has(key) ? store.get(key) : null;
    },
    putText(key, text) {
      store.set(key, text);
    },
  };
}

// ---------------------------------------------------------------------------
// Server meta store (multi-board registry)
// ---------------------------------------------------------------------------

await runPrestartCommands(prestartCommands);

const serverMetaStore = createConfigBackedServerMetaStore(serverConfig.boards ? Object.entries(serverConfig.boards) : []);

// ---------------------------------------------------------------------------
// Build multi-board runtime
// ---------------------------------------------------------------------------

const apiBasePath = '/api/boards';
const invocationAdapter = createNodeSpawnInvocationAdapter();
const notificationTransport = createNamedPipeNotificationTransport();
const logger = { info: console.log, warn: console.warn, error: console.error };

// Map config keys to board entries for the factory
const boardConfigEntries = serverConfig.boards ? Object.entries(serverConfig.boards) : [];
const boardConfigMap = new Map(boardConfigEntries);

function buildBoardContextConfig(label, boardSetupPaths, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, executionExtra = {}) {
  fs.mkdirSync(boardSetupPaths.boardRuntimePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.cardStorePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.artifactsStorePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.boardOutputsStorePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.chatStorePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.scratchStorePath, { recursive: true });
  fs.mkdirSync(boardSetupPaths.archivalStorePath, { recursive: true });

  const notifyChannel = `yaml-flow-server-${label}-${boardId}-${process.pid}`;
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardSetupPaths.boardRuntimePath }));
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, { notifyChannel });
  boardAdapter.requestProcessAccumulated = () => {};

  const artifactsRef = parseRef(serializeRef({ kind: 'fs-path', value: boardSetupPaths.artifactsStorePath }));
  const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, { suppressSpawn: true });
  const cardStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.cardStorePath });

  return {
    label,
    boardAdapter,
    artifactsAdapter,
    baseRef,
    cardStoreRef,
    outputsStoreRef: serializeRef({ kind: 'fs-path', value: boardSetupPaths.boardOutputsStorePath }),
    scratchStoreRef: serializeRef({ kind: 'fs-path', value: boardSetupPaths.scratchStorePath }),
    archiveStoreRef: serializeRef({ kind: 'fs-path', value: boardSetupPaths.archivalStorePath }),
    notifyRef: { kind: 'named-pipe', value: namedPipePath(notifyChannel) },
    taskExecutorRef: makeExecutionRef(taskExecPath, executionExtra),
    chatHandlerFlow,
    inferenceAdapterRef: makeExecutionRef(infAdapterPath),
  };
}

/**
 * Thin wrapper around the shared execution-ref invoker that pins the board
 * server's cliDir/cwd/label defaults for chat-flow steps.
 */
function invokeExecutionRefAsync(ref, args, opts) {
  return invokeExecutionRef(ref, args, {
    cliDir: opts?.cliDir || BOARD_ROOT,
    cwd: opts?.cwd || BOARD_ROOT,
    timeoutMs: typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : undefined,
    label: 'board-server-chat-flow',
  });
}

const runtime = createMultiBoardServerRuntime({
  apiBasePath,
  serverMetaStore,
  logger,
  boardRuntimeFactory: (boardId, entry) => {
    const cfg = boardConfigMap.get(boardId);
    const regular = cfg?.regular || {};

    const cardsDir = resolveFromConfig(regular.seedCardsDir);
    const taskExecPath = resolveFromConfig(regular.taskExecutorPath) || (entry?.taskExecutorPath || configuredTaskExecutorPath);
    const chatHandlerPath = resolveFromConfig(regular.chatHandlerPath) || (entry?.chatHandlerPath || configuredChatHandlerPath);
    const boardFlowTimeoutMs = configuredChatFlowTimeoutMs;
    const chatHandlerFlow = applyFlowTimeout(
      loadJsonFromConfig(regular.chatHandlerFlowPath)
        || entry?.chatHandlerFlow
        || buildChatHandlerFlowFromScript(chatHandlerPath, boardFlowTimeoutMs)
        || configuredChatHandlerFlow,
      boardFlowTimeoutMs,
    );
    const infAdapterPath = resolveFromConfig(regular.inferenceAdapterPath) || (entry?.inferenceAdapterPath || configuredInferenceAdapterPath);
    const stepMachinePath = resolveFromConfig(regular.stepMachineCliPath || cfg?.stepMachineCliPath) || (entry?.stepMachineCliPath || configuredStepMachineCliPath);
    const chatInvokeRefTimeoutMs = configuredInvokeRefTimeoutMs;
    const chatCopilotTimeoutMs = configuredCopilotTimeoutMs;

    if (chatHandlerPath && !process.env.DEMO_CHAT_HANDLER_PATH) {
      process.env.DEMO_CHAT_HANDLER_PATH = chatHandlerPath;
    }
    if (infAdapterPath && !process.env.DEMO_INFERENCE_ADAPTER_PATH) {
      process.env.DEMO_INFERENCE_ADAPTER_PATH = infAdapterPath;
    }

    const boardSetupRootOverride = (process.env.DEMO_BOARD_SETUP_ROOT || '').trim();
    const boardSetupPaths = resolveBoardSetupPaths(cfg, boardId, boardSetupRootOverride);
    const chatFlowRoot = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
    fs.mkdirSync(boardSetupPaths.setupRoot, { recursive: true });
    const flowRunner = createStepMachineChatFlowRunner({
      invokeRef: (ref, stepArgs) => invokeExecutionRefAsync(ref, stepArgs, {
        cliDir: BOARD_ROOT,
        cwd: BOARD_ROOT,
        timeoutMs: chatInvokeRefTimeoutMs,
      }),
    });
    const baseExecutionExtra = {
      boardSetupRoot: boardSetupPaths.setupRoot,
      boardRuntimeDir: boardSetupPaths.boardRuntime,
      chatStore: boardSetupPaths.chatStore,
      runtimeStatusDir: boardSetupPaths.boardOutputsStore,
      artifactsStore: boardSetupPaths.artifactsStore,
      scratchStore: boardSetupPaths.scratchStore,
      archivalStore: boardSetupPaths.archivalStore,
      projectRoot: BOARD_ROOT,
      chatFlowRoot,
      serverUrl: `http://127.0.0.1:${PORT}`,
      chatCopilotTimeoutMs,
      ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
    };

    const baseCfg = buildBoardContextConfig('base', boardSetupPaths, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, baseExecutionExtra);
    const boards = [baseCfg];

    demoPrepSetup({ cardsDir, boardDir: boardSetupPaths.boardRuntimePath });

    const chatStorage = createFsBoardChatStorage(boardSetupPaths.chatStorePath);

    const singleBoardRuntime = createSingleBoardServerRuntime({
      apiBasePath: `${apiBasePath}/${boardId}`,
      boardId,
      chatStorage,
      boards,
      invocationAdapter,
      chatFlowRunner: flowRunner,
      notificationTransport,
      logger,
      serverUrl: `http://127.0.0.1:${PORT}`,
      executionExtra: {
        boardSetupRoot: boardSetupPaths.setupRoot,
        boardRuntimeDir: boardSetupPaths.boardRuntime,
        chatStore: boardSetupPaths.chatStore,
        runtimeStatusDir: boardSetupPaths.boardOutputsStore,
        artifactsStore: boardSetupPaths.artifactsStore,
        scratchStore: boardSetupPaths.scratchStore,
        archivalStore: boardSetupPaths.archivalStore,
        projectRoot: BOARD_ROOT,
        chatFlowRoot,
        chatCopilotTimeoutMs,
        ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
      },
    });

    // Seed card store from source cardsDir if empty
    const existing = singleBoardRuntime.cardStore.get({});
    const isEmpty = existing.status !== 'success' || !existing.data?.cards?.length;
    if (isEmpty && cardsDir) {
      const cards = createFsCardSource(cardsDir, selectedCardsPattern).listCards();
      if (cards.length) singleBoardRuntime.cardStore.set({ body: cards });
    }

    return singleBoardRuntime;
  },
});

// ---------------------------------------------------------------------------
// Host setup — writes copilot-instructions.md into the board setup root.
// ---------------------------------------------------------------------------

function demoPrepSetup({ cardsDir, boardDir }) {
  if (!cardsDir) return;

  const boardSetupRoot = path.dirname(boardDir);
  fs.mkdirSync(boardSetupRoot, { recursive: true });
  const srcDir = path.dirname(cardsDir);
  const agentInstructionFiles = ['agent-instructions.md', 'agent-instructions-cardlayout.md'];
  const parts = [];
  for (const fname of agentInstructionFiles) {
    const fpath = path.join(srcDir, fname);
    if (fs.existsSync(fpath)) parts.push(fs.readFileSync(fpath, 'utf-8').trimEnd());
  }
  if (parts.length > 0) {
    fs.writeFileSync(path.join(boardSetupRoot, 'copilot-instructions.md'), parts.join('\n\n') + '\n', 'utf-8');
  }
}

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function getSeedCardsForBoard(boardId) {
  const cfg = boardConfigMap.get(boardId);
  const regular = cfg?.regular || {};
  const cardsDir = resolveFromConfig(regular.seedCardsDir);
  if (!cardsDir) {
    return { cardsDir: null, cards: [] };
  }
  const cards = createFsCardSource(cardsDir, selectedCardsPattern).listCards();
  return { cardsDir, cards };
}

function upsertCardInRuntimeStore(cardStore, card) {
  const existing = cardStore.get({});
  const existingCards = Array.isArray(existing.data?.cards) ? existing.data.cards : [];
  const nextCards = [];
  let replaced = false;

  for (const existingCard of existingCards) {
    if (existingCard?.id === card.id) {
      nextCards.push(card);
      replaced = true;
    } else {
      nextCards.push(existingCard);
    }
  }

  if (!replaced) {
    nextCards.push(card);
  }

  return cardStore.set({ body: nextCards });
}

async function patchCardViaApi(boardId, cardId, card) {
  const response = await fetch(`http://127.0.0.1:${PORT}${apiBasePath}/${boardId}/cards/${encodeURIComponent(cardId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function resyncSeedCards(boardId) {
  const { service } = runtime.requireBoardService(boardId);
  const { cardsDir, cards } = getSeedCardsForBoard(boardId);

  if (!cardsDir) {
    return {
      boardId,
      cardsDir: null,
      synced: 0,
      skipped: 0,
      results: [],
      error: 'Board has no seedCardsDir configured',
    };
  }

  const results = [];

  for (const card of cards) {
    const cardId = typeof card?.id === 'string' ? card.id.trim() : '';
    if (!cardId) {
      results.push({ ok: false, cardId: null, error: 'Seed card is missing id' });
      continue;
    }

    const setResult = upsertCardInRuntimeStore(service.cardStore, card);
    if (setResult.status !== 'success') {
      results.push({
        ok: false,
        cardId,
        step: 'cardStore.set',
        error: setResult.error || 'cardStore.set failed',
      });
      continue;
    }

    const patchResult = await patchCardViaApi(boardId, cardId, card);
    results.push({
      ok: patchResult.ok,
      cardId,
      step: 'patch',
      status: patchResult.status,
      error: patchResult.ok ? null : (patchResult.payload?.error || `PATCH failed with status ${patchResult.status}`),
    });
  }

  return {
    boardId,
    cardsDir,
    synced: results.filter((result) => result.ok).length,
    skipped: results.filter((result) => !result.ok).length,
    results,
  };
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const remoteAddress = req.socket?.remoteAddress || 'unknown';

  console.log(`[board-server] ${method} ${pathname}${url.search} <- ${remoteAddress}`);

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const resyncMatch = pathname.match(/^\/api\/boards\/([^/]+)\/resync-seedcards$/);
  if (method === 'POST' && resyncMatch) {
    const boardId = decodeURIComponent(resyncMatch[1] || '').trim();
    (async () => {
      try {
        const result = await resyncSeedCards(boardId);
        if (result.error) {
          jsonReply(res, 400, result);
          return;
        }
        const hasErrors = result.results.some((entry) => !entry.ok);
        jsonReply(res, hasErrors ? 207 : 200, result);
      } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        jsonReply(res, statusCode, {
          error: String(error?.message || error),
          boardId,
        });
      }
    })();
    return;
  }

  // All other /api/boards routes are handled by the platform-free runtime
  runtime.handleApi(req, res, url).then((handled) => {
    if (!handled) {
      jsonReply(res, 404, { error: 'Not found' });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[board-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[board-server] setup dir: ${setupDir}`);
  console.log('[board-server] endpoints:');
  console.log(`  GET  ${apiBasePath}                          <- list boards`);
  console.log(`  POST ${apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${apiBasePath}/:boardId/init-board`);
  console.log(`  GET  ${apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${apiBasePath}/:boardId/board-status`);
  console.log(`  POST ${apiBasePath}/:boardId/resync-seedcards`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  PATCH ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/actions   <- card actions, including chat-send`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/chats`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/subscribe-sse`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/unsubscribe-sse`);
});