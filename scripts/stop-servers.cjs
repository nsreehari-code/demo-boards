#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspaceDir = path.resolve(__dirname, '..');
const tempDir = path.join(workspaceDir, '.tmp');
const pidFile = path.join(tempDir, 'server-processes.json');

function getExpectedPorts(name) {
  if (name === 'board-server') {
    return [7799];
  }

  if (name === 'mcp-server') {
    return [7801];
  }

  if (name === 'frontend') {
    return [8000];
  }

  if (name === 'vite') {
    return [5510];
  }

  return [];
}

function getStopPriority(name) {
  if (name === 'board-server') {
    return 0;
  }

  if (name === 'mcp-server') {
    return 1;
  }

  return 2;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getWindowsListeningPids(ports) {
  if (!Array.isArray(ports) || ports.length === 0) {
    return [];
  }

  const command = [
    `$ports = @(${ports.join(', ')})`,
    'Get-NetTCPConnection -State Listen | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique',
  ].join('; ');

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    return [];
  }

  return String(result.stdout)
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

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

function stopTrackedProcess(processInfo) {
  if (killProcessTree(processInfo.pid)) {
    return true;
  }

  if (process.platform !== 'win32') {
    return false;
  }

  const fallbackPids = getWindowsListeningPids(getExpectedPorts(processInfo.name));
  if (fallbackPids.length === 0) {
    return false;
  }

  let stoppedAny = false;
  for (const pid of fallbackPids) {
    if (pid === processInfo.pid) {
      continue;
    }

    if (killProcessTree(pid)) {
      stoppedAny = true;
    }
  }

  return stoppedAny;
}

function isAlreadyStopped(processInfo) {
  if (isPidAlive(processInfo.pid)) {
    return false;
  }

  if (process.platform !== 'win32') {
    return true;
  }

  return getWindowsListeningPids(getExpectedPorts(processInfo.name)).length === 0;
}

const knownServices = [
  { name: 'board-server', ports: [7799] },
  { name: 'mcp-server', ports: [7801] },
  { name: 'frontend', ports: [8000] },
  { name: 'vite', ports: [5510] },
];

if (!fs.existsSync(pidFile)) {
  if (process.platform === 'win32') {
    console.log('[stop:servers] No pid file. Attempting port-based shutdown...');
    let stoppedAny = false;
    for (const service of knownServices) {
      for (const pid of getWindowsListeningPids(service.ports)) {
        if (killProcessTree(pid)) {
          console.log(`[stop:servers] stopped ${service.name} (pid ${pid})`);
          stoppedAny = true;
        }
      }
    }
    if (!stoppedAny) {
      console.log('[stop:servers] No managed services found on known ports.');
    }
  } else {
    console.log('[stop:servers] No pid file found. Nothing to stop.');
  }
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

const processes = Array.isArray(state.processes)
  ? [...state.processes].sort((left, right) => getStopPriority(left.name) - getStopPriority(right.name))
  : [];
if (processes.length === 0) {
  fs.rmSync(pidFile, { force: true });
  console.log('[stop:servers] No tracked processes found.');
  process.exit(0);
}

for (const processInfo of processes) {
  const stopped = stopTrackedProcess(processInfo) || isAlreadyStopped(processInfo);
  console.log(`[stop:servers] ${stopped ? 'stopped' : 'skipped'} ${processInfo.name} (pid ${processInfo.pid})`);
}

fs.rmSync(pidFile, { force: true });
console.log('[stop:servers] Done.');