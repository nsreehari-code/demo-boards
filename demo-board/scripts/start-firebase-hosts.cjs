#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const boardDir = path.resolve(__dirname, '..');
const controlfaceDir = path.join(boardDir, 'server-controlface-firebase');
const queueRunnerDir = path.join(boardDir, 'server-queue-runner-firebase');

for (const dirPath of [controlfaceDir, queueRunnerDir]) {
  if (!fs.existsSync(dirPath)) {
    console.error(`[start-firebase-hosts] Missing ${dirPath}`);
    process.exit(1);
  }
}

const npmCliPath = process.env.npm_execpath;
const sharedEnv = { ...process.env };
let shuttingDown = false;

if (!npmCliPath || !fs.existsSync(npmCliPath)) {
  console.error('[start-firebase-hosts] Unable to resolve npm CLI path from npm_execpath');
  process.exit(1);
}

function startPackage(dirPath, label) {
  const child = spawn(process.execPath, [npmCliPath, 'start'], {
    cwd: dirPath,
    env: sharedEnv,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[start-firebase-hosts] ${label} exited with code ${code ?? 0}`);
    shutdown();
  });
  return child;
}

const controlface = startPackage(controlfaceDir, 'controlface');
const queueRunner = startPackage(queueRunnerDir, 'queue-runner');

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
