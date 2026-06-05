#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const boardDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(boardDir, 'server', 'hosted-board-runtime');
const controlfaceEntry = path.join(runtimeDir, 'http-mcp-controlface', 'controlface-server.js');
const queueRunnerEntry = path.join(runtimeDir, 'queue-runner', 'queue-runner.js');
const localfsConfigArgv = ['--config', './hosted-board-runtime.localfs.config.json'];

for (const entryPath of [controlfaceEntry, queueRunnerEntry]) {
  if (!fs.existsSync(entryPath)) {
    console.error(`[start-local-hosts] Missing ${entryPath}`);
    process.exit(1);
  }
}

const sharedEnv = { ...process.env };
let shuttingDown = false;

function startRuntime(entryPath, label) {
  const child = spawn(process.execPath, [entryPath, ...localfsConfigArgv], {
    cwd: runtimeDir,
    env: sharedEnv,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[start-local-hosts] ${label} exited with code ${code ?? 0}`);
    shutdown();
  });
  return child;
}

const controlface = startRuntime(controlfaceEntry, 'controlface');
const queueRunner = startRuntime(queueRunnerEntry, 'queue-runner');

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [controlface, queueRunner]) {
    if (child && !child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of [controlface, queueRunner]) {
      if (child && !child.killed) child.kill('SIGKILL');
    }
    process.exit(0);
  }, 1200);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
