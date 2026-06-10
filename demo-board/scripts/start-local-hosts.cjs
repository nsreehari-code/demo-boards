#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const boardDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(boardDir, 'server', 'hosted-board-runtime');
const hostedServerLogPath = path.join(boardDir, 'logs', 'hosted-server.log');
const prepareHostsEntry = path.join(runtimeDir, 'scripts', 'prepare-local-hosts.js');
const controlfaceEntry = path.join(runtimeDir, 'http-mcp-controlface', 'controlface-server.js');
const queueRunnerEntry = path.join(runtimeDir, 'queue-runner', 'queue-runner.js');
const localfsConfigArgv = ['--config', './hosted-board-runtime.localfs.config.json'];

for (const entryPath of [prepareHostsEntry, controlfaceEntry, queueRunnerEntry]) {
  if (!fs.existsSync(entryPath)) {
    console.error(`[start-local-hosts] Missing ${entryPath}`);
    process.exit(1);
  }
}

const sharedEnv = { ...process.env };
let shuttingDown = false;
let runtimeChildren = [];

function retainLastLogLines(filePath, maxLines = 1000) {
  if (!filePath || !Number.isInteger(maxLines) || maxLines <= 0 || !fs.existsSync(filePath)) {
    return;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const normalizedLines = lines.length > 0 && lines[lines.length - 1] === ''
      ? lines.slice(0, -1)
      : lines;
    if (normalizedLines.length <= maxLines) {
      return;
    }
    fs.writeFileSync(filePath, `${normalizedLines.slice(-maxLines).join('\n')}\n`, 'utf8');
  } catch (error) {
    console.warn(`[start-local-hosts] failed to trim hosted log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const runtimeChild of runtimeChildren) {
    if (runtimeChild && !runtimeChild.killed) runtimeChild.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const runtimeChild of runtimeChildren) {
      if (runtimeChild && !runtimeChild.killed) runtimeChild.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 1200);
}

function prepareHosts() {
  retainLastLogLines(hostedServerLogPath, 1000);
  const child = spawn(process.execPath, [prepareHostsEntry, ...localfsConfigArgv], {
    cwd: runtimeDir,
    env: sharedEnv,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if ((code ?? 0) !== 0) {
      console.error(`[start-local-hosts] prepare-local-hosts exited with code ${code ?? 0}`);
      process.exit(code ?? 1);
    }
    const controlface = startRuntime(controlfaceEntry, 'controlface');
    const queueRunner = startRuntime(queueRunnerEntry, 'queue-runner');
    runtimeChildren = [controlface, queueRunner];

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function startRuntime(entryPath, label) {
  const child = spawn(process.execPath, [entryPath, ...localfsConfigArgv], {
    cwd: runtimeDir,
    env: sharedEnv,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[start-local-hosts] ${label} exited with code ${code ?? 0}`);
    shutdown(code ?? 0);
  });
  return child;
}

prepareHosts();
