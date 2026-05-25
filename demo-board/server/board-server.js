#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  COPILOT_OUTPUT_CHANNEL,
  parseCopilotOutputFileName,
} from '../../../watchparty-constants.mjs';

import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from 'yaml-flow/board-live-cards-server-runtime';

import {
  createFsBoardPlatformAdapter,
  createFsBoardChatStorage,
  createNodeSpawnInvocationAdapter,
  createArtifactsStore,
  evaluateArgsMassaging,
  invokeExecutionRef,
  parseRef,
  resolveWhatToRunValue,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';
import {
  MemoryStore,
  buildStepHandlersForFlow,
  createStepMachine,
  loadStepFlow,
} from 'yaml-flow/step-machine-public';

const __filename = fileURLToPath(import.meta.url);
const SERVER_DIR = path.dirname(__filename);
const BOARD_ROOT = path.resolve(SERVER_DIR, '..');
const require = createRequire(import.meta.url);
const YAML_FLOW_CLI_DIR = path.join(BOARD_ROOT, 'scripts', 'yaml-flow');
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

function requireConfiguredPathText(configValue, configKey) {
  if (typeof configValue !== 'string') {
    throw new Error(`[board-server] Missing required config: ${configKey}`);
  }
  const normalized = configValue.trim();
  if (!normalized) {
    throw new Error(`[board-server] Missing required config: ${configKey}`);
  }
  return normalized;
}

function resolveRequiredPathFromConfig(configValue, configKey) {
  return path.resolve(BOARD_ROOT, requireConfiguredPathText(configValue, configKey));
}

function ensureDirectoryExists(dirPath, label) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new Error('path is not a directory');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[board-server] Required directory unavailable for ${label}: ${dirPath}\n${detail}`);
  }
}

const DEFAULT_SETUP_LEAVES = {
  boardRuntime: 'runtime',
  boardOutputsStore: 'board-outputs',
  cardStore: 'cards-store',
  artifactsStore: 'cards-files',
  chatStore: 'cards-chats',
  scratchStore: 'scratch',
  archivalStore: 'runtime-archive',
};

const WATCHPARTY_FILES_FOR_CHAT_DIRNAME = 'watchparty-files-for-chat';

function resolveConfiguredBoardSetupRoot(cfg, boardId, boardSetupRootOverride) {
  if (boardSetupRootOverride) {
    return path.resolve(boardSetupRootOverride, `board-${boardId}`);
  }

  const explicitSetupRoot = cfg?.setup && typeof cfg.setup === 'object'
    ? cfg.setup.setupRoot
    : cfg?.setupRoot;

  if (explicitSetupRoot) {
    return resolveRequiredPathFromConfig(explicitSetupRoot, `boards.${boardId}.setupRoot`);
  }

  if (cfg?.setupDir) {
    throw new Error(`[board-server] boards.${boardId}.setupDir is no longer supported. Configure boards.${boardId}.setupRoot or boards.${boardId}.setup.setupRoot explicitly.`);
  }

  throw new Error(`[board-server] Missing required config: boards.${boardId}.setupRoot`);
}

function resolveBoardSetupPaths(cfg, boardId, boardSetupRootOverride) {
  const setupCfg = cfg?.setup && typeof cfg.setup === 'object' ? cfg.setup : {};
  const setupRoot = resolveConfiguredBoardSetupRoot(cfg, boardId, boardSetupRootOverride);

  const leaves = {
    aiWorkspaceRoot:   requireConfiguredPathText(setupCfg.aiWorkspaceRoot, `boards.${boardId}.setup.aiWorkspaceRoot`),
    boardRuntime:      requireConfiguredPathText(setupCfg.boardRuntime ?? DEFAULT_SETUP_LEAVES.boardRuntime, `boards.${boardId}.setup.boardRuntime`),
    boardOutputsStore: requireConfiguredPathText(setupCfg.boardOutputsStore ?? DEFAULT_SETUP_LEAVES.boardOutputsStore, `boards.${boardId}.setup.boardOutputsStore`),
    cardStore:         requireConfiguredPathText(setupCfg.cardStore ?? DEFAULT_SETUP_LEAVES.cardStore, `boards.${boardId}.setup.cardStore`),
    artifactsStore:    requireConfiguredPathText(setupCfg.artifactsStore ?? DEFAULT_SETUP_LEAVES.artifactsStore, `boards.${boardId}.setup.artifactsStore`),
    chatStore:         requireConfiguredPathText(setupCfg.chatStore ?? DEFAULT_SETUP_LEAVES.chatStore, `boards.${boardId}.setup.chatStore`),
    scratchStore:      requireConfiguredPathText(setupCfg.scratchStore ?? DEFAULT_SETUP_LEAVES.scratchStore, `boards.${boardId}.setup.scratchStore`),
    archivalStore:     requireConfiguredPathText(setupCfg.archivalStore ?? DEFAULT_SETUP_LEAVES.archivalStore, `boards.${boardId}.setup.archivalStore`),
  };
  const toAbs = (leaf) => (path.isAbsolute(leaf) ? leaf : path.resolve(setupRoot, leaf));

  return {
    setupRoot,
    ...leaves,
    aiWorkspaceRootPath:   toAbs(leaves.aiWorkspaceRoot),
    boardRuntimePath:      toAbs(leaves.boardRuntime),
    boardOutputsStorePath: toAbs(leaves.boardOutputsStore),
    cardStorePath:         toAbs(leaves.cardStore),
    artifactsStorePath:    toAbs(leaves.artifactsStore),
    chatStorePath:         toAbs(leaves.chatStore),
    scratchStorePath:      toAbs(leaves.scratchStore),
    archivalStorePath:     toAbs(leaves.archivalStore),
  };
}

function ensureBoardSetupPaths(boardId, boardSetupPaths) {
  ensureDirectoryExists(boardSetupPaths.setupRoot, `boards.${boardId}.setup.setupRoot`);
  ensureDirectoryExists(boardSetupPaths.aiWorkspaceRootPath, `boards.${boardId}.setup.aiWorkspaceRoot`);
  ensureDirectoryExists(boardSetupPaths.boardRuntimePath, `boards.${boardId}.setup.boardRuntime`);
  ensureDirectoryExists(boardSetupPaths.boardOutputsStorePath, `boards.${boardId}.setup.boardOutputsStore`);
  ensureDirectoryExists(boardSetupPaths.cardStorePath, `boards.${boardId}.setup.cardStore`);
  ensureDirectoryExists(boardSetupPaths.artifactsStorePath, `boards.${boardId}.setup.artifactsStore`);
  ensureDirectoryExists(boardSetupPaths.chatStorePath, `boards.${boardId}.setup.chatStore`);
  ensureDirectoryExists(boardSetupPaths.scratchStorePath, `boards.${boardId}.setup.scratchStore`);
  ensureDirectoryExists(boardSetupPaths.archivalStorePath, `boards.${boardId}.setup.archivalStore`);
}

function validateConfiguredBoardSetupPaths(entries, boardSetupRootOverride) {
  for (const [boardId, cfg] of entries) {
    const boardSetupPaths = resolveBoardSetupPaths(cfg, boardId, boardSetupRootOverride);
    ensureBoardSetupPaths(boardId, boardSetupPaths);
  }
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

function normalizeNonNegativeTimeoutMs(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function normalizePrestartCommands(configValue) {
  if (!Array.isArray(configValue)) return [];
  return configValue
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function listFilesInDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function listFilesRecursive(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const out = [];
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        out.push(entryPath);
      }
    }
  };
  walk(dirPath);
  return out;
}

function resolveLastUserText(chatStorage, cardId, lastChatEntryId) {
  if (!chatStorage || typeof chatStorage.readAll !== 'function') return '';
  if (typeof cardId !== 'string' || !cardId.trim()) return '';
  if (typeof lastChatEntryId !== 'string' || !lastChatEntryId.trim()) return '';
  try {
    const messages = chatStorage.readAll(cardId);
    if (!Array.isArray(messages)) return '';
    const entry = messages.find((message) => (
      message
      && message.id === lastChatEntryId
      && message.role === 'user'
      && typeof message.text === 'string'
    ));
    return entry ? entry.text.trim() : '';
  } catch {
    return '';
  }
}

function createLocalStepMachineChatFlowRunner(invokeRef) {
  return {
    async run(flowSpec, args) {
      try {
        const flow = await loadStepFlow(flowSpec);
        const handlers = buildStepHandlersForFlow(flow, {
          invoke: (ref, stepArgs) => invokeRef(ref, stepArgs, {
            timeoutMs: resolveInvokeTimeoutMs(flow),
          }),
        });
        const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
        const run = await machine.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {});

        if (run.status !== 'completed') {
          const reason = run.error?.message ?? run.intent ?? run.status;
          return { dispatched: false, error: String(reason || 'flow execution failed') };
        }

        if (run.intent !== 'success') {
          const reason = typeof run.data?.error === 'string'
            ? run.data.error
            : `flow returned intent: ${run.intent}`;
          return { dispatched: false, error: reason };
        }

        return { dispatched: true, runId: run.runId };
      } catch (error) {
        return {
          dispatched: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createUserTextAwareChatFlowRunner(chatStorage, invokeRef) {
  const innerRunner = createLocalStepMachineChatFlowRunner(invokeRef);
  return {
    run(flow, args, ...rest) {
      const flowArgs = args && typeof args === 'object' && !Array.isArray(args)
        ? { ...args }
        : {};
      if (typeof flowArgs.userText !== 'string' || !flowArgs.userText.trim()) {
        const derivedUserText = resolveLastUserText(chatStorage, flowArgs.cardId, flowArgs.lastChatEntryId);
        if (derivedUserText) {
          flowArgs.userText = derivedUserText;
        }
      }
      return innerRunner.run(flow, flowArgs, ...rest);
    },
  };
}

function resolveInvokeTimeoutMs(flow) {
  const flowTimeoutMs = normalizeNonNegativeTimeoutMs(flow?.settings?.invoke_timeout_ms, null);
  if (flowTimeoutMs !== null) return flowTimeoutMs;

  const envTimeoutMs = normalizeNonNegativeTimeoutMs(process.env.YAML_FLOW_STEP_INVOKE_TIMEOUT_MS, null);
  if (envTimeoutMs !== null) return envTimeoutMs;

  return 300000;
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

function applyFlowTimeout(flow, timeoutMs, invokeTimeoutMs = null) {
  if (!flow || typeof flow !== 'object') return flow;
  const normalized = normalizeTimeoutMs(timeoutMs, null);
  const normalizedInvoke = normalizeNonNegativeTimeoutMs(invokeTimeoutMs, null);
  if (normalized === null && normalizedInvoke === null) return flow;
  return {
    ...flow,
    settings: {
      ...(flow.settings && typeof flow.settings === 'object' ? flow.settings : {}),
      ...(normalized !== null ? { timeout_ms: normalized } : {}),
      ...(normalizedInvoke !== null ? { invoke_timeout_ms: normalizedInvoke } : {}),
    },
  };
}

function buildChatHandlerFlowFromScript(scriptPath, timeoutMs = null, invokeTimeoutMs = null) {
  if (!scriptPath) return null;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(BOARD_ROOT, scriptPath);
  const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs, 300000);
  const resolvedInvokeTimeoutMs = normalizeNonNegativeTimeoutMs(invokeTimeoutMs, 300000);
  return {
    id: 'demo-chat-script-handler',
    settings: {
      start_step: 'respond',
      max_total_steps: 5,
      timeout_ms: resolvedTimeoutMs,
      invoke_timeout_ms: resolvedInvokeTimeoutMs,
    },
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
const configuredInvokeRefTimeoutMs = normalizeNonNegativeTimeoutMs(serverConfig.chatInvokeRefTimeoutMs, 300000);
const configuredCopilotTimeoutMs = normalizeTimeoutMs(serverConfig.chatCopilotTimeoutMs, 300000);

// Resolve top-level config defaults
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath);
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredFlowFromPath = loadJsonFromConfig(serverConfig.chatHandlerFlowPath);
const configuredChatHandlerFlow = applyFlowTimeout(
  configuredFlowFromPath || buildChatHandlerFlowFromScript(configuredChatHandlerPath, configuredChatFlowTimeoutMs, configuredInvokeRefTimeoutMs),
  configuredChatFlowTimeoutMs,
  configuredInvokeRefTimeoutMs,
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
const SERVER_STARTED_AT = Date.now();
const SERVER_INSTANCE_ID = `${process.pid}-${SERVER_STARTED_AT}`;
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
    writeCard(cardId, card) {
      ensureDirectoryExists(cardsDir, 'seedCardsDir');
      const filePath = path.join(cardsDir, `${cardId}.json`);
      fs.writeFileSync(filePath, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
      return filePath;
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

// ---------------------------------------------------------------------------
// Watchparty broker — per-board registry of SSE writers and channel
// subscriptions, wired via onSse*/onChannel* hooks in v8.4.15+.
// ---------------------------------------------------------------------------
function createWatchpartyBroker() {
  const writers = new Map();       // clientId → writer fn
  const subscriptions = new Map(); // `${channelName}::${cardId}` → Set<clientId>

  function subKey(channelName, cardId) {
    return cardId ? `${channelName}::${cardId}` : channelName;
  }

  return {
    onConnect(clientId, writer) {
      writers.set(clientId, writer);
    },
    onDisconnect(clientId) {
      writers.delete(clientId);
      for (const [key, clients] of subscriptions) {
        clients.delete(clientId);
        if (clients.size === 0) subscriptions.delete(key);
      }
    },
    hasClient(clientId) {
      return writers.has(clientId);
    },
    onSubscribe(clientId, channelName, params) {
      const key = subKey(channelName, params?.cardId);
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(clientId);
      return true;
    },
    onUnsubscribe(clientId, channelName, params) {
      const key = subKey(channelName, params?.cardId);
      const clients = subscriptions.get(key);
      if (!clients) return false;
      clients.delete(clientId);
      if (clients.size === 0) subscriptions.delete(key);
      return true;
    },
    emit(channelName, cardId, eventPayload) {
      const key = subKey(channelName, cardId);
      const clients = subscriptions.get(key);
      if (!clients?.size) return 0;
      const frame = {
        kind: 'notification-batch',
        notifications: [{ kind: 'card_watchparty', cardId, channel: channelName, ...eventPayload }],
      };
      let sent = 0;
      for (const clientId of [...clients]) {
        const writer = writers.get(clientId);
        if (!writer) continue;
        try { writer(frame); sent++; } catch { writers.delete(clientId); clients.delete(clientId); }
      }
      return sent;
    },
  };
}

function createWatchpartyDirectoryWatcher(broker, watchDir) {
  let watcher = null;
  let scanTimer = null;
  const timers = new Map();
  const lastSnapshots = new Map();
  const filePollers = new Set();

  function clearTimer(fileName) {
    const existing = timers.get(fileName);
    if (existing) {
      clearTimeout(existing);
      timers.delete(fileName);
    }
  }

  function stopFilePoller(fileName) {
    if (!filePollers.has(fileName)) {
      return;
    }
    filePollers.delete(fileName);
    try {
      fs.unwatchFile(path.join(watchDir, fileName));
    } catch {}
  }

  function ensureFilePoller(fileName) {
    if (filePollers.has(fileName)) {
      return;
    }
    const filePath = path.join(watchDir, fileName);
    fs.watchFile(filePath, { interval: 100 }, (curr, prev) => {
      if (
        curr.mtimeMs !== prev.mtimeMs
        || curr.size !== prev.size
        || curr.nlink !== prev.nlink
      ) {
        emitFileSnapshot(fileName);
        if (curr.nlink === 0) {
          stopFilePoller(fileName);
        }
      }
    });
    filePollers.add(fileName);
  }

  function emitFileSnapshot(fileName) {
    clearTimer(fileName);
    const cardId = parseCopilotOutputFileName(fileName);
    if (!cardId) {
      return;
    }

    const filePath = path.join(watchDir, fileName);
    let text = '';
    let clear = false;
    try {
      if (fs.existsSync(filePath)) {
        text = fs.readFileSync(filePath, 'utf-8');
      } else {
        clear = true;
      }
    } catch {
      return;
    }

    const snapshotKey = clear ? '__CLEAR__' : text;
    if (lastSnapshots.get(fileName) === snapshotKey) {
      return;
    }
    lastSnapshots.set(fileName, snapshotKey);
    if (clear) {
      stopFilePoller(fileName);
    }

    broker.emit(COPILOT_OUTPUT_CHANNEL, cardId, clear ? { clear: true } : { replace: true, payload: { text } });
  }

  function scanWatchDir() {
    const fileNames = new Set(lastSnapshots.keys());
    const existingWatchedFiles = new Set();
    try {
      if (fs.existsSync(watchDir)) {
        for (const entry of fs.readdirSync(watchDir, { withFileTypes: true })) {
          if (entry.isFile()) {
            fileNames.add(entry.name);
          }
        }
      }
    } catch {
      return;
    }

    for (const fileName of fileNames) {
      if (!parseCopilotOutputFileName(fileName)) {
        continue;
      }
      if (fs.existsSync(path.join(watchDir, fileName))) {
        existingWatchedFiles.add(fileName);
        ensureFilePoller(fileName);
      }
      emitFileSnapshot(fileName);
    }

    for (const fileName of [...filePollers]) {
      if (!existingWatchedFiles.has(fileName)) {
        stopFilePoller(fileName);
      }
    }
  }

  return {
    ensureStarted() {
      if (watcher) {
        return;
      }

      ensureDirectoryExists(watchDir, 'watchparty directory');
      watcher = fs.watch(watchDir, (eventType, fileNameValue) => {
        const fileName = typeof fileNameValue === 'string' ? fileNameValue.trim() : '';
        if (!fileName) {
          return;
        }

        if (parseCopilotOutputFileName(fileName)) {
          ensureFilePoller(fileName);
        }

        clearTimer(fileName);
        const timer = setTimeout(() => emitFileSnapshot(fileName), eventType === 'rename' ? 40 : 0);
        timers.set(fileName, timer);
      });
      watcher.on('error', () => {
        try { watcher?.close(); } catch {}
        watcher = null;
      });
      scanTimer = setInterval(scanWatchDir, 100);
      scanWatchDir();
    },
    close() {
      for (const fileName of timers.keys()) {
        clearTimer(fileName);
      }
      for (const fileName of [...filePollers]) {
        stopFilePoller(fileName);
      }
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      if (watcher) {
        try { watcher.close(); } catch {}
        watcher = null;
      }
    },
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
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
const boardSetupRootOverride = (process.env.DEMO_BOARD_SETUP_ROOT || '').trim();

validateConfiguredBoardSetupPaths(boardConfigEntries, boardSetupRootOverride);

function buildBoardContextConfig(label, boardSetupPaths, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, executionExtra = {}) {
  ensureBoardSetupPaths(boardId, boardSetupPaths);

  const notifyChannel = `yaml-flow-server-${label}-${boardId}-${process.pid}`;
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardSetupPaths.boardRuntimePath }));
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, YAML_FLOW_CLI_DIR, { notifyChannel });
  boardAdapter.requestProcessAccumulated = () => {};

  const artifactsRef = parseRef(serializeRef({ kind: 'fs-path', value: boardSetupPaths.artifactsStorePath }));
  const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, YAML_FLOW_CLI_DIR, { suppressSpawn: true });
  const artifactsStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.artifactsStorePath });
  const cardStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.cardStorePath });
  const chatStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.chatStorePath });

  return {
    label,
    boardAdapter,
    artifactsAdapter,
    baseRef,
    artifactsStoreRef,
    cardStoreRef,
    chatStoreRef,
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
    transports: {
      'local-node': invokeExecutionRefViaExecFile,
      'local-python': invokeExecutionRefViaExecFile,
      'local-process': invokeExecutionRefViaExecFile,
    },
  });
}

function invokeExecutionRefViaExecFile(ref, args, opts) {
  const label = opts?.label || 'board-server-chat-flow';
  let massaged;
  try {
    massaged = evaluateArgsMassaging(
      ref.argsMassaging,
      {
        ...args,
        whatToRun: resolveWhatToRunValue(ref.whatToRun),
        ...(ref.extra ? { extra: ref.extra } : {}),
      },
      label,
    );
  } catch (error) {
    return Promise.resolve(toExecutionFailure(error instanceof Error ? error.message : String(error)));
  }

  let command;
  let baseArgs;
  try {
    ({ command, baseArgs } = resolveAsyncExecutionCommand(ref));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(toExecutionFailure(`[${label}] ref resolution failed: ${message}`));
  }

  const commandArgs = [...baseArgs, ...(massaged.cmdArgs ?? [])];
  const stdin = JSON.stringify(massaged.stdin ?? args);

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: opts?.cwd || BOARD_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isShellWrappedCommand(command),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 30_000;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try { child.kill(); } catch {}
      resolve(toExecutionFailure(`[${label}] timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(toExecutionFailure(`[${label}] ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `process exited ${code}`;
        resolve(toExecutionFailure(`[${label}] ${details}`));
        return;
      }
      resolve(parseExecutionStdout(stdout));
    });

    child.stdin.end(stdin);
  });
}

function resolveAsyncExecutionCommand(ref) {
  const whatToRun = resolveWhatToRunValue(ref.whatToRun);
  switch (ref.howToRun) {
    case 'local-node':
      return { command: process.execPath, baseArgs: [whatToRun] };
    case 'local-python':
      return { command: process.platform === 'win32' ? 'python' : 'python3', baseArgs: [whatToRun] };
    case 'local-process':
      return { command: whatToRun, baseArgs: [] };
    default:
      throw new Error(`unsupported async transport: ${ref.howToRun}`);
  }
}

function isShellWrappedCommand(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function toExecutionFailure(message) {
  return { result: 'failure', data: { error: message } };
}

function parseExecutionStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return { result: 'success', data: {} };
  }

  try {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1]);
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof parsed.result === 'string'
      && parsed.data
      && typeof parsed.data === 'object'
      && !Array.isArray(parsed.data)
    ) {
      return parsed;
    }
    return {
      result: 'success',
      data: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { stdout: text },
    };
  } catch {
    return { result: 'success', data: { stdout: text } };
  }
}

const watchpartyBrokers = new Map(); // boardId → WatchpartyBroker
const watchpartyDirectoryWatchers = new Map(); // boardId → directory watcher

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
    const chatInvokeRefTimeoutMs = configuredInvokeRefTimeoutMs;
    const chatHandlerFlow = applyFlowTimeout(
      loadJsonFromConfig(regular.chatHandlerFlowPath)
        || entry?.chatHandlerFlow
        || buildChatHandlerFlowFromScript(chatHandlerPath, boardFlowTimeoutMs, chatInvokeRefTimeoutMs)
        || configuredChatHandlerFlow,
      boardFlowTimeoutMs,
      chatInvokeRefTimeoutMs,
    );
    const infAdapterPath = resolveFromConfig(regular.inferenceAdapterPath) || (entry?.inferenceAdapterPath || configuredInferenceAdapterPath);
    const stepMachinePath = resolveFromConfig(regular.stepMachineCliPath || cfg?.stepMachineCliPath) || (entry?.stepMachineCliPath || configuredStepMachineCliPath);
    const chatCopilotTimeoutMs = configuredCopilotTimeoutMs;

    if (chatHandlerPath && !process.env.DEMO_CHAT_HANDLER_PATH) {
      process.env.DEMO_CHAT_HANDLER_PATH = chatHandlerPath;
    }
    if (infAdapterPath && !process.env.DEMO_INFERENCE_ADAPTER_PATH) {
      process.env.DEMO_INFERENCE_ADAPTER_PATH = infAdapterPath;
    }

    const boardSetupPaths = resolveBoardSetupPaths(cfg, boardId, boardSetupRootOverride);
    const baseRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.boardRuntimePath });
    const aiWorkspaceRoot = boardSetupPaths.aiWorkspaceRootPath;
    const artifactsStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.artifactsStorePath });
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.cardStorePath });
    const chatStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.chatStorePath });
    const scratchStoreRef = serializeRef({ kind: 'fs-path', value: boardSetupPaths.scratchStorePath });
    const watchPartyFilesForChatDir = path.join(boardSetupPaths.setupRoot, WATCHPARTY_FILES_FOR_CHAT_DIRNAME);
    const chatFlowRoot = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
    ensureBoardSetupPaths(boardId, boardSetupPaths);
    ensureDirectoryExists(watchPartyFilesForChatDir, `boards.${boardId}.watchPartyFilesForChatDir`);
    const chatStorage = createFsBoardChatStorage(boardSetupPaths.chatStorePath);
    const flowRunner = createUserTextAwareChatFlowRunner(
      chatStorage,
      (ref, stepArgs, opts) => invokeExecutionRefAsync(ref, stepArgs, {
        cliDir: BOARD_ROOT,
        cwd: BOARD_ROOT,
        timeoutMs: opts?.timeoutMs,
      }),
    );
    const baseExecutionExtra = {
      boardId,
      baseRef,
      aiWorkspaceRoot,
      boardSetupRoot: boardSetupPaths.setupRoot,
      boardRuntimeDir: boardSetupPaths.boardRuntime,
      cardStoreRef,
      chatStoreRef,
      runtimeStatusDir: boardSetupPaths.boardOutputsStore,
      artifactsStore: boardSetupPaths.artifactsStore,
      artifactsStoreRef,
      scratchStore: boardSetupPaths.scratchStore,
      scratchStoreRef,
      archivalStore: boardSetupPaths.archivalStore,
      projectRoot: BOARD_ROOT,
      chatFlowRoot,
      serverUrl: `http://127.0.0.1:${PORT}`,
      watchPartyFilesForChatDir,
      chatCopilotTimeoutMs,
      ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
    };

    const baseCfg = buildBoardContextConfig('base', boardSetupPaths, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, baseExecutionExtra);
    const boards = [baseCfg];

    demoPrepSetup({ boardId, cfg, cardsDir, boardSetupRoot: boardSetupPaths.setupRoot, aiWorkspaceRoot });

    const broker = createWatchpartyBroker();
    watchpartyBrokers.set(boardId, broker);
    watchpartyDirectoryWatchers.set(boardId, createWatchpartyDirectoryWatcher(broker, watchPartyFilesForChatDir));

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
      onSseClientConnected: (clientId, writer) => broker.onConnect(clientId, writer),
      onSseClientDisconnected: (clientId) => broker.onDisconnect(clientId),
      onChannelSubscribed: (clientId, channelName, params) => broker.onSubscribe(clientId, channelName, params),
      onChannelUnsubscribed: (clientId, channelName, params) => broker.onUnsubscribe(clientId, channelName, params),
      executionExtra: {
        baseRef,
        aiWorkspaceRoot,
        boardSetupRoot: boardSetupPaths.setupRoot,
        boardRuntimeDir: boardSetupPaths.boardRuntime,
        cardStoreRef,
        chatStoreRef,
        runtimeStatusDir: boardSetupPaths.boardOutputsStore,
        artifactsStore: boardSetupPaths.artifactsStore,
        artifactsStoreRef,
        scratchStore: boardSetupPaths.scratchStore,
        scratchStoreRef,
        archivalStore: boardSetupPaths.archivalStore,
        projectRoot: BOARD_ROOT,
        chatFlowRoot,
        watchPartyFilesForChatDir,
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
// Host setup — prepares Copilot workspaces under the board setup root.
// ---------------------------------------------------------------------------

function demoPrepSetup({ boardId, cfg, cardsDir, boardSetupRoot, aiWorkspaceRoot }) {
  ensureDirectoryExists(boardSetupRoot, `boards.${boardId}.setup.setupRoot`);

  const workspaceSetup = Array.isArray(cfg?.['copilot-workdirs-setup'])
    ? cfg['copilot-workdirs-setup'].filter((entry) => entry && typeof entry === 'object')
    : [];

  if (workspaceSetup.length > 0) {
    const copilotWorkspaceRoot = aiWorkspaceRoot;
    fs.mkdirSync(copilotWorkspaceRoot, { recursive: true });

    for (const entry of workspaceSetup) {
      const copilotRoot = typeof entry['copilot-root'] === 'string' ? entry['copilot-root'].trim() : '';
      if (!copilotRoot) continue;

      const workspaceRoot = path.join(copilotWorkspaceRoot, copilotRoot);
      const githubRoot = path.join(workspaceRoot, '.github');
      const instructionsTarget = path.join(githubRoot, 'copilot-instructions.md');
      const legacyInstructionsTarget = path.join(workspaceRoot, 'copilot-instructions.md');
      const agentsTarget = path.join(workspaceRoot, '.github', 'agents');
      const hooksTarget = path.join(workspaceRoot, '.github', 'hooks');
      const skillsTarget = path.join(workspaceRoot, '.github', 'skills');
      const scriptsTarget = path.join(workspaceRoot, '.github', 'scripts');

      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(githubRoot, { recursive: true });
      fs.rmSync(agentsTarget, { recursive: true, force: true });
      fs.rmSync(hooksTarget, { recursive: true, force: true });
      fs.rmSync(skillsTarget, { recursive: true, force: true });
      fs.rmSync(scriptsTarget, { recursive: true, force: true });
      fs.mkdirSync(agentsTarget, { recursive: true });
      fs.mkdirSync(hooksTarget, { recursive: true });
      fs.mkdirSync(skillsTarget, { recursive: true });
      fs.mkdirSync(scriptsTarget, { recursive: true });

      const logCopiedFiles = (label, dirPath, copiedCount) => {
        console.log(
          `[board-server] copilot workspace "${copilotRoot}" ${label} dir: ${dirPath} (${copiedCount} files copied)`,
        );
      };

      const instructionDirs = Array.isArray(entry.instructionsDirs) ? entry.instructionsDirs : [];
      const instructionParts = [];
      for (const dir of instructionDirs) {
        const resolvedDir = resolveFromConfig(dir);
        if (!resolvedDir || !fs.existsSync(resolvedDir)) {
          logCopiedFiles('instructionsDirs', resolvedDir, 0);
          continue;
        }
        const files = listFilesInDir(resolvedDir);
        for (const filePath of files) {
          instructionParts.push(fs.readFileSync(filePath, 'utf-8').trimEnd());
        }
        logCopiedFiles('instructionsDirs', resolvedDir, files.length);
      }

      if (instructionParts.length > 0) {
        fs.writeFileSync(instructionsTarget, instructionParts.join('\n===============\n') + '\n', 'utf-8');
        fs.rmSync(legacyInstructionsTarget, { force: true });
      } else {
        fs.rmSync(instructionsTarget, { force: true });
        fs.rmSync(legacyInstructionsTarget, { force: true });
      }

      const agentsDirs = Array.isArray(entry.agentsDirs) ? entry.agentsDirs : [];
      for (const dir of agentsDirs) {
        const resolvedDir = resolveFromConfig(dir);
        if (!resolvedDir || !fs.existsSync(resolvedDir)) {
          logCopiedFiles('agentsDirs', resolvedDir, 0);
          continue;
        }
        const files = listFilesRecursive(resolvedDir);
        for (const filePath of files) {
          fs.copyFileSync(filePath, path.join(agentsTarget, path.basename(filePath)));
        }
        logCopiedFiles('agentsDirs', resolvedDir, files.length);
      }

      const agentsHooks = Array.isArray(entry.agentsHooks) ? entry.agentsHooks : [];
      for (const dir of agentsHooks) {
        const resolvedDir = resolveFromConfig(dir);
        if (!resolvedDir || !fs.existsSync(resolvedDir)) {
          logCopiedFiles('agentsHooks', resolvedDir, 0);
          continue;
        }
        const files = listFilesRecursive(resolvedDir);
        for (const filePath of files) {
          fs.copyFileSync(filePath, path.join(hooksTarget, path.basename(filePath)));
        }
        logCopiedFiles('agentsHooks', resolvedDir, files.length);
      }

      const agentsSkills = Array.isArray(entry.agentsSkills) ? entry.agentsSkills : [];
      for (const dir of agentsSkills) {
        const resolvedDir = resolveFromConfig(dir);
        if (!resolvedDir || !fs.existsSync(resolvedDir)) {
          logCopiedFiles('agentsSkills', resolvedDir, 0);
          continue;
        }
        const files = listFilesRecursive(resolvedDir);
        for (const filePath of files) {
          const relativePath = path.relative(resolvedDir, filePath);
          const targetPath = path.join(skillsTarget, relativePath);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(filePath, targetPath);
        }
        logCopiedFiles('agentsSkills', resolvedDir, files.length);
      }

      const copyScriptDirs = Array.isArray(entry.copyScripts)
        ? entry.copyScripts
            .map((dir) => resolveFromConfig(dir))
            .filter(Boolean)
        : [];
      console.log(
        `[board-server] copilot workspace "${copilotRoot}" copyScripts: ${copyScriptDirs.length > 0 ? copyScriptDirs.join(', ') : '(none)'}`,
      );
      for (const scriptsDir of copyScriptDirs) {
        if (!scriptsDir || !fs.existsSync(scriptsDir)) {
          logCopiedFiles('copyScripts', scriptsDir, 0);
          continue;
        }
        let copiedCount = 0;
        for (const fileName of fs.readdirSync(scriptsDir)) {
          const sourcePath = path.join(scriptsDir, fileName);
          const stat = fs.statSync(sourcePath);
          if (!stat.isFile()) continue;
          fs.copyFileSync(sourcePath, path.join(scriptsTarget, fileName));
          copiedCount += 1;
        }
        logCopiedFiles('copyScripts', scriptsDir, copiedCount);
      }
    }
    return;
  }

  if (!cardsDir) return;

  const srcDir = path.dirname(cardsDir);
  const agentInstructionFiles = ['agent-instructions.md', 'agent-instructions-cardlayout.md'];
  const parts = [];
  for (const fname of agentInstructionFiles) {
    const fpath = path.join(srcDir, fname);
    if (fs.existsSync(fpath)) parts.push(fs.readFileSync(fpath, 'utf-8').trimEnd());
  }
  if (parts.length > 0) {
    const githubRoot = path.join(boardSetupRoot, '.github');
    fs.mkdirSync(githubRoot, { recursive: true });
    fs.writeFileSync(path.join(githubRoot, 'copilot-instructions.md'), parts.join('\n\n') + '\n', 'utf-8');
    fs.rmSync(path.join(boardSetupRoot, 'copilot-instructions.md'), { force: true });
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

function getRuntimeCardsForBoard(boardId) {
  const { service } = runtime.requireBoardService(boardId);
  const existing = service.cardStore.get({});
  if (existing.status !== 'success') {
    return {
      cards: [],
      error: existing.error || 'Unable to read runtime cards',
      statusCode: 500,
    };
  }

  let cards = Array.isArray(existing.data?.cards) ? existing.data.cards : [];
  if (selectedCardsPattern) {
    const cardRegex = wildcardToRegExp(selectedCardsPattern);
    cards = cards.filter((card) => cardRegex.test(typeof card?.id === 'string' ? card.id.trim() : ''));
  }

  return {
    cards,
    error: null,
    statusCode: null,
  };
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

async function resetRuntimeFromSeedCards(boardId) {
  const { service } = runtime.requireBoardService(boardId);
  const { cardsDir, cards } = getSeedCardsForBoard(boardId);

  if (!cardsDir) {
    return {
      boardId,
      cardsDir: null,
      statusCode: 400,
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

async function reverseSaveRuntimeToSeedCards(boardId) {
  const { cardsDir } = getSeedCardsForBoard(boardId);

  if (!cardsDir) {
    return {
      boardId,
      cardsDir: null,
      statusCode: 400,
      saved: 0,
      skipped: 0,
      results: [],
      error: 'Board has no seedCardsDir configured',
    };
  }

  const runtimeCards = getRuntimeCardsForBoard(boardId);
  if (runtimeCards.error) {
    return {
      boardId,
      cardsDir,
      statusCode: runtimeCards.statusCode || 500,
      saved: 0,
      skipped: 0,
      results: [],
      error: runtimeCards.error,
    };
  }

  const cardSource = createFsCardSource(cardsDir, selectedCardsPattern);
  const results = [];

  for (const card of runtimeCards.cards) {
    const cardId = typeof card?.id === 'string' ? card.id.trim() : '';
    if (!cardId) {
      results.push({ ok: false, cardId: null, error: 'Runtime card is missing id' });
      continue;
    }

    try {
      const filePath = cardSource.writeCard(cardId, card);
      results.push({ ok: true, cardId, step: 'write', filePath });
    } catch (error) {
      results.push({
        ok: false,
        cardId,
        step: 'write',
        error: String(error?.message || error),
      });
    }
  }

  return {
    boardId,
    cardsDir,
    saved: results.filter((result) => result.ok).length,
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

  if (method === 'GET' && pathname === '/healthz') {
    jsonReply(res, 200, {
      ok: true,
      status: 'ok',
      startedAt: new Date(SERVER_STARTED_AT).toISOString(),
      uptimeMs: Date.now() - SERVER_STARTED_AT,
      instanceId: SERVER_INSTANCE_ID,
      pid: process.pid,
    });
    return;
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const resetRuntimeFromSeedCardsMatch = pathname.match(/^\/api\/boards\/([^/]+)\/reset-runtime-from-seed-cards$/);
  if (method === 'POST' && resetRuntimeFromSeedCardsMatch) {
    const boardId = decodeURIComponent(resetRuntimeFromSeedCardsMatch[1] || '').trim();
    (async () => {
      try {
        const result = await resetRuntimeFromSeedCards(boardId);
        if (result.error) {
          jsonReply(res, Number(result.statusCode) || 400, result);
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

  const reverseSaveRuntimeToSeedCardsMatch = pathname.match(/^\/api\/boards\/([^/]+)\/reverse-save-runtime-to-seed-cards$/);
  if (method === 'POST' && reverseSaveRuntimeToSeedCardsMatch) {
    const boardId = decodeURIComponent(reverseSaveRuntimeToSeedCardsMatch[1] || '').trim();
    (async () => {
      try {
        const result = await reverseSaveRuntimeToSeedCards(boardId);
        if (result.error) {
          jsonReply(res, Number(result.statusCode) || 400, result);
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

  const watchpartyCardChannelMatch = pathname.match(/^\/api\/boards\/([^/]+)\/cards\/([^/]+)\/watch-channel\/([^/]+)\/(subscribe|unsubscribe)-sse$/);
  if (method === 'POST' && watchpartyCardChannelMatch) {
    const boardId = decodeURIComponent(watchpartyCardChannelMatch[1] || '').trim();
    const cardId = decodeURIComponent(watchpartyCardChannelMatch[2] || '').trim();
    const channelName = decodeURIComponent(watchpartyCardChannelMatch[3] || '').trim();
    const action = watchpartyCardChannelMatch[4] || '';
    (async () => {
      try {
        const body = await readRequestBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        const broker = watchpartyBrokers.get(boardId);
        if (!clientId) {
          jsonReply(res, 400, { error: 'clientId is required' });
          return;
        }
        if (!broker) {
          jsonReply(res, 404, { error: `No watchparty broker for board: ${boardId}` });
          return;
        }
        if (action === 'subscribe') {
          watchpartyDirectoryWatchers.get(boardId)?.ensureStarted();
        }
        if (!broker.hasClient(clientId)) {
          jsonReply(res, 404, { error: `SSE client not connected: ${clientId}` });
          return;
        }

        const subscribed = action === 'subscribe';
        if (subscribed) {
          broker.onSubscribe(clientId, channelName, { cardId });
        } else {
          broker.onUnsubscribe(clientId, channelName, { cardId });
        }

        jsonReply(res, 200, { ok: true, boardId, cardId, channel: channelName, clientId, subscribed });
      } catch (error) {
        jsonReply(res, 500, { error: String(error?.message || error) });
      }
    })();
    return;
  }

  const watchpartyBoardChannelMatch = pathname.match(/^\/api\/boards\/([^/]+)\/watch-channel\/([^/]+)\/(subscribe|unsubscribe)-sse$/);
  if (method === 'POST' && watchpartyBoardChannelMatch) {
    const boardId = decodeURIComponent(watchpartyBoardChannelMatch[1] || '').trim();
    const channelName = decodeURIComponent(watchpartyBoardChannelMatch[2] || '').trim();
    const action = watchpartyBoardChannelMatch[3] || '';
    (async () => {
      try {
        const body = await readRequestBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        const broker = watchpartyBrokers.get(boardId);
        if (!clientId) {
          jsonReply(res, 400, { error: 'clientId is required' });
          return;
        }
        if (!broker) {
          jsonReply(res, 404, { error: `No watchparty broker for board: ${boardId}` });
          return;
        }
        if (action === 'subscribe') {
          watchpartyDirectoryWatchers.get(boardId)?.ensureStarted();
        }
        if (!broker.hasClient(clientId)) {
          jsonReply(res, 404, { error: `SSE client not connected: ${clientId}` });
          return;
        }

        const subscribed = action === 'subscribe';
        if (subscribed) {
          broker.onSubscribe(clientId, channelName, {});
        } else {
          broker.onUnsubscribe(clientId, channelName, {});
        }

        jsonReply(res, 200, { ok: true, boardId, channel: channelName, clientId, subscribed });
      } catch (error) {
        jsonReply(res, 500, { error: String(error?.message || error) });
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
  console.log('[board-server] endpoints:');
  console.log('  GET  /healthz                               <- process liveness probe');
  console.log(`  GET  ${apiBasePath}                          <- list boards`);
  console.log(`  POST ${apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${apiBasePath}/:boardId/init-board`);
  console.log(`  GET  ${apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${apiBasePath}/:boardId/board-status`);
  console.log(`  POST ${apiBasePath}/:boardId/reset-runtime-from-seed-cards`);
  console.log(`  POST ${apiBasePath}/:boardId/reverse-save-runtime-to-seed-cards`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  PATCH ${apiBasePath}/:boardId/cards/:id       <- update card content/data`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/retrigger <- refresh/restart card`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/actions   <- card actions, including chat-send`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/chats`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/subscribe-sse`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/unsubscribe-sse`);
});