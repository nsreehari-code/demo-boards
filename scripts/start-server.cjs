#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const workspaceDir = process.cwd();
const args = process.argv.slice(2);
const boardDirArg = args.find(a => !a.startsWith('--')) || 'demo-board';
const boardDir = path.resolve(workspaceDir, boardDirArg);
const runtimeLauncherPath = path.join(boardDir, 'scripts', 'start-local-hosts.cjs');

if (!fs.existsSync(runtimeLauncherPath)) {
  console.error(`[start-server] Missing ${runtimeLauncherPath}. Pass a valid board directory, for example "demo-board".`);
  process.exit(1);
}

const mcpServerPath = path.resolve(workspaceDir, 'mcp-server', 'src', 'index.js');
if (!fs.existsSync(mcpServerPath)) {
  console.error(`[start-server] Missing ${mcpServerPath}. Run \"npm install\" first.`);
  process.exit(1);
}

const sharedEnv = {
  ...process.env,
};

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
console.log(`[start-server] controlface: launched from ${path.relative(workspaceDir, runtimeLauncherPath)}`);
console.log('[start-server] mcp:      http://127.0.0.1:7801/mcp');
console.log('[start-server] frontend: https://nsreehari-code.github.io/demo-boards');

const mcp = spawn(process.execPath, [mcpServerPath, '--transport', 'streamable-http'], {
  cwd: path.resolve(workspaceDir, 'mcp-server'),
  env: sharedEnv,
  stdio: 'inherit',
  windowsHide: true,
});

const hostedRuntime = spawn(process.execPath, [runtimeLauncherPath], {
  cwd: boardDir,
  env: sharedEnv,
  stdio: 'inherit',
  windowsHide: true,
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (!mcp.killed) mcp.kill('SIGTERM');
  if (!hostedRuntime.killed) hostedRuntime.kill('SIGTERM');

  setTimeout(() => {
    if (!mcp.killed) mcp.kill('SIGKILL');
    if (!hostedRuntime.killed) hostedRuntime.kill('SIGKILL');
    process.exit(0);
  }, 1200);

  if (!signal) {
    process.exit(0);
  }
}

mcp.on('exit', (code) => {
  void handleMcpExit(code);
});

hostedRuntime.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[start-server] hosted runtime exited with code ${code ?? 0}`);
    shutdown();
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
