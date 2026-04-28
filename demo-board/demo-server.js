#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  createMultiBoardServerRuntime,
  createRuntimeRequestDispatcher,
  isRuntimeRoute,
} from 'yaml-flow/board-livecards-server-runtime';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _require = createRequire(import.meta.url);

function resolveYamlFlowDir() {
  try {
    return path.dirname(_require.resolve('yaml-flow/package.json'));
  } catch {
    return null;
  }
}

const _yamlFlowDir = resolveYamlFlowDir();
const _pkgCliJs = _yamlFlowDir ? path.join(_yamlFlowDir, 'board-live-cards-cli.js') : null;
const _pkgStepMachineCli = _yamlFlowDir ? path.join(_yamlFlowDir, 'step-machine-cli.js') : null;

function loadServerConfig() {
  const configPath = path.join(__dirname, 'demo-server-config.json');
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
  return path.resolve(__dirname, configValue);
}

const serverConfig = loadServerConfig();
const configuredCliJs = resolveFromConfig(serverConfig.boardLiveCardsCliJs) || _pkgCliJs;

if (!process.env.BOARD_LIVE_CARDS_CLI_JS && configuredCliJs) {
  process.env.BOARD_LIVE_CARDS_CLI_JS = configuredCliJs;
}

const sharedCliJs = process.env.BOARD_LIVE_CARDS_CLI_JS || configuredCliJs;
const sharedStepMachineCli = process.env.DEMO_STEP_MACHINE_CLI_PATH || _pkgStepMachineCli;

const PORT = Number(process.env.DEMO_SERVER_PORT || serverConfig.port || 7799);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

// Build per-board runtimes from config
const boardEntries = serverConfig.boards ? Object.entries(serverConfig.boards) : [];
const boardRuntimes = boardEntries.map(([key, cfg]) => {
  const setupDir = resolveFromConfig(cfg.setupDir);
  const cardsDir = resolveFromConfig(cfg.cardsDir);
  const taskExec = resolveFromConfig(cfg.taskExecutorPath);
  const chatHandler = resolveFromConfig(cfg.chatHandlerPath);
  const stepMachineCli = resolveFromConfig(cfg.stepMachineCliPath) || sharedStepMachineCli;
  const gandalfCards = resolveFromConfig(cfg.gandalfCardsDir);
  const gandalfTaskExec = resolveFromConfig(cfg.gandalfTaskExecutorPath);
  const gandalfChatHandler = resolveFromConfig(cfg.gandalfChatHandlerPath);

  if (chatHandler && !process.env.DEMO_CHAT_HANDLER_PATH) {
    process.env.DEMO_CHAT_HANDLER_PATH = chatHandler;
  }
  if (stepMachineCli && !process.env.DEMO_STEP_MACHINE_CLI_PATH) {
    process.env.DEMO_STEP_MACHINE_CLI_PATH = stepMachineCli;
  }

  const runtime = createMultiBoardServerRuntime({
    apiBasePath: `/api/${key}`,
    serverUrl: `http://127.0.0.1:${PORT}`,
    setupDir: setupDir || null,
    defaultCardsDir: cardsDir || null,
    defaultTaskExecutorPath: taskExec || null,
    defaultStepMachineCliPath: stepMachineCli,
    defaultChatHandlerPath: chatHandler || null,
    defaultGandalfCardsDir: gandalfCards || null,
    defaultGandalfTaskExecutorPath: gandalfTaskExec || null,
    defaultGandalfChatHandlerPath: gandalfChatHandler || null,
    boardLiveCardsCliJs: sharedCliJs,
  });

  return {
    key,
    label: cfg.label || key,
    runtime,
    dispatch: createRuntimeRequestDispatcher(runtime),
  };
});

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleWorkiqAsk(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let query;
  try {
    query = JSON.parse(body).query;
  } catch {
    return jsonReply(res, 400, { error: 'Invalid JSON body' });
  }
  if (!query || typeof query !== 'string') {
    return jsonReply(res, 400, { error: '{ query } string is required' });
  }

  const workiqJs = path.join(
    process.env.APPDATA || os.homedir(),
    'npm', 'node_modules', '@microsoft', 'workiq', 'bin', 'workiq.js'
  );
  if (!fs.existsSync(workiqJs)) {
    return jsonReply(res, 503, { error: `WorkIQ CLI not found at: ${workiqJs}` });
  }

  // Server has TTY on stdin — workiq can produce output.
  // Use async spawn (not spawnSync) to avoid blocking the event loop during the call.
  await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let responded = false;
    const child = spawn(process.execPath, [workiqJs, 'ask', '-q', query], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', (err) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeoutId);
        jsonReply(res, 500, { error: `workiq spawn error: ${err.message}` });
      }
      resolve();
    });
    child.on('close', (code) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeoutId);
        if (code !== 0) {
          jsonReply(res, 500, { error: `workiq exited ${code}`, stderr });
        } else {
          jsonReply(res, 200, { response: stdout });
        }
      }
      resolve();
    });
    const timeoutId = setTimeout(() => {
      if (!responded) {
        responded = true;
        child.kill();
        jsonReply(res, 504, { error: 'workiq timed out after 60s' });
      }
      resolve();
    }, 60_000);
  });
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // GET /api/config — available boards for the UI selector
  if (method === 'GET' && pathname === '/api/config') {
    const boards = boardRuntimes.map(({ key, label }) => ({ key, label }));
    return jsonReply(res, 200, boards);
  }

  // Route: POST /api/workiq/ask — proxy to WorkIQ (M365 Copilot) from server TTY
  if (method === 'POST' && pathname === '/api/workiq/ask') {
    void handleWorkiqAsk(req, res);
    return;
  }

  // Route to matching board runtime by URL prefix
  for (const { key, dispatch } of boardRuntimes) {
    if (pathname.startsWith(`/api/${key}/`)) {
      void dispatch(req, res);
      return;
    }
  }

  jsonReply(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-server] listening on http://127.0.0.1:${PORT}`);
  for (const { key, label, runtime } of boardRuntimes) {
    console.log(`[demo-server] board "${key}" (${label}): ${runtime.setupDir}`);
  }
  console.log('[demo-server] endpoints:');
  console.log('  GET  /api/config                                <- available boards');
  for (const { key } of boardRuntimes) {
    console.log(`  GET  /api/${key}/:boardId/bootstrap`);
    console.log(`  GET  /api/${key}/:boardId/sse`);
    console.log(`  PATCH /api/${key}/:boardId/cards/:id`);
    console.log(`  POST /api/${key}/:boardId/cards/:id/actions`);
  }
  console.log('  POST /api/workiq/ask  {query}                    <- WorkIQ proxy');
});
