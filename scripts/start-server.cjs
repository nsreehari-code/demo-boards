#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const workspaceDir = process.cwd();
const args = process.argv.slice(2);
const modeFlag = args.find(a => a === '--all' || a === '--backend') || '--backend';
const boardDirArg = args.find(a => !a.startsWith('--')) || 'default-board';
const boardDir = path.resolve(workspaceDir, boardDirArg);
const demoServerPath = path.join(boardDir, 'demo-server.js');

if (!fs.existsSync(demoServerPath)) {
  console.error(`[start-server] Missing ${demoServerPath}. Run \"npm run copy-example-board\" first.`);
  process.exit(1);
}

const boardLiveCardsCliJs = path.resolve(workspaceDir, 'node_modules', 'yaml-flow', 'board-live-cards-cli.js');
const stepMachineCliPath = path.resolve(workspaceDir, 'node_modules', 'yaml-flow', 'step-machine-cli.js');

if (!fs.existsSync(boardLiveCardsCliJs)) {
  console.error(`[start-server] Missing ${boardLiveCardsCliJs}. Run \"npm install\" first.`);
  process.exit(1);
}
if (!fs.existsSync(stepMachineCliPath)) {
  console.error(`[start-server] Missing ${stepMachineCliPath}. Run \"npm install\" first.`);
  process.exit(1);
}

const sharedEnv = {
  ...process.env,
  BOARD_LIVE_CARDS_CLI_JS: boardLiveCardsCliJs,
  DEMO_STEP_MACHINE_CLI_PATH: stepMachineCliPath,
};

console.log(`[start-server] board dir: ${boardDir}`);
console.log('[start-server] backend:  http://127.0.0.1:7799');
if (modeFlag === '--all') {
  console.log('[start-server] frontend: http://127.0.0.1:8000');
}

const backend = spawn(process.execPath, [demoServerPath], {
  cwd: boardDir,
  env: sharedEnv,
  stdio: 'inherit',
});

let frontend = null;
if (modeFlag === '--all') {
  const httpServerEntry = require.resolve('http-server/bin/http-server');
  frontend = spawn(process.execPath, [httpServerEntry, boardDir, '-p', '8000', '-c-1'], {
    cwd: workspaceDir,
    stdio: 'inherit',
  });
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (!backend.killed) backend.kill('SIGTERM');
  if (frontend && !frontend.killed) frontend.kill('SIGTERM');

  setTimeout(() => {
    if (!backend.killed) backend.kill('SIGKILL');
    if (frontend && !frontend.killed) frontend.kill('SIGKILL');
    process.exit(0);
  }, 1200);

  if (!signal) {
    process.exit(0);
  }
}

backend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[start-server] backend exited with code ${code ?? 0}`);
    shutdown();
  }
});

if (frontend) {
  frontend.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[start-server] frontend exited with code ${code ?? 0}`);
      shutdown();
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
