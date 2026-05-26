#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const workspaceDir = process.cwd();
const args = process.argv.slice(2);
const boardDirArg = args.find(a => !a.startsWith('--')) || 'demo-board';
const boardDir = path.resolve(workspaceDir, boardDirArg);
const boardServerPath = path.join(boardDir, 'server', 'board-server.js');

if (!fs.existsSync(boardServerPath)) {
  console.error(`[start-server] Missing ${boardServerPath}. Pass a valid board directory, for example "demo-board".`);
  process.exit(1);
}

const mcpServerPath = path.resolve(workspaceDir, 'mcp-server', 'src', 'index.js');
const frontendDir = path.resolve(workspaceDir, 'docs');
if (!fs.existsSync(mcpServerPath)) {
  console.error(`[start-server] Missing ${mcpServerPath}. Run \"npm install\" first.`);
  process.exit(1);
}
if (!fs.existsSync(frontendDir)) {
  console.error(`[start-server] Missing ${frontendDir}. Frontend artifacts now live in docs/. Fetch or rebuild them from the separate demo-boards-frontend repo.`);
  process.exit(1);
}

const sharedEnv = {
  ...process.env,
};
const backendHost = String(sharedEnv.DEMO_SERVER_HOST || '127.0.0.1').trim() || '127.0.0.1';

function isPortReachable(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function handleMcpExit(code) {
  if (shuttingDown) return;
  const reachable = await isPortReachable(7801);
  if (reachable) {
    console.log('[start-server] reusing existing MCP server on http://127.0.0.1:7801/mcp');
    return;
  }
  console.error(`[start-server] mcp exited with code ${code ?? 0}`);
  shutdown();
}

console.log(`[start-server] board dir: ${boardDir}`);
console.log(`[start-server] backend:  http://${backendHost}:7799`);
console.log('[start-server] mcp:      http://127.0.0.1:7801/mcp');
console.log('[start-server] frontend: http://127.0.0.1:8000');

const mcp = spawn(process.execPath, [mcpServerPath, '--transport', 'streamable-http'], {
  cwd: path.resolve(workspaceDir, 'mcp-server'),
  env: sharedEnv,
  stdio: 'inherit',
});

const backend = spawn(process.execPath, [boardServerPath], {
  cwd: boardDir,
  env: sharedEnv,
  stdio: 'inherit',
});

let frontend = null;
const httpServerEntry = require.resolve('http-server/bin/http-server');
frontend = spawn(process.execPath, [httpServerEntry, frontendDir, '-p', '8000', '-c-1'], {
  cwd: workspaceDir,
  stdio: 'inherit',
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (!mcp.killed) mcp.kill('SIGTERM');
  if (!backend.killed) backend.kill('SIGTERM');
  if (frontend && !frontend.killed) frontend.kill('SIGTERM');

  setTimeout(() => {
    if (!mcp.killed) mcp.kill('SIGKILL');
    if (!backend.killed) backend.kill('SIGKILL');
    if (frontend && !frontend.killed) frontend.kill('SIGKILL');
    process.exit(0);
  }, 1200);

  if (!signal) {
    process.exit(0);
  }
}

mcp.on('exit', (code) => {
  void handleMcpExit(code);
});

backend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[start-server] backend exited with code ${code ?? 0}`);
    shutdown();
  }
});

frontend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[start-server] frontend exited with code ${code ?? 0}`);
    shutdown();
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
