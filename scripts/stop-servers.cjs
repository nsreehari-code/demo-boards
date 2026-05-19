#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspaceDir = path.resolve(__dirname, '..');
const tempDir = path.join(workspaceDir, '.tmp');
const pidFile = path.join(tempDir, 'server-processes.json');

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return result.status === 0;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

if (!fs.existsSync(pidFile)) {
  console.log('[stop:servers] No pid file found. Nothing to stop.');
  process.exit(0);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
} catch {
  fs.rmSync(pidFile, { force: true });
  console.log('[stop:servers] Removed unreadable pid file.');
  process.exit(0);
}

const processes = Array.isArray(state.processes) ? state.processes : [];
if (processes.length === 0) {
  fs.rmSync(pidFile, { force: true });
  console.log('[stop:servers] No tracked processes found.');
  process.exit(0);
}

for (const processInfo of processes) {
  const stopped = killProcessTree(processInfo.pid);
  console.log(`[stop:servers] ${stopped ? 'stopped' : 'skipped'} ${processInfo.name} (pid ${processInfo.pid})`);
}

fs.rmSync(pidFile, { force: true });
console.log('[stop:servers] Done.');