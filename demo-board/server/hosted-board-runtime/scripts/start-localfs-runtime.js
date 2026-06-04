#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const pidFilePath = path.join(runtimeRoot, '.runtime-pids.json');
const configFilePath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');

function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
  } catch {
    return {};
  }
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readConfiguredControlfacePort() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const port = Number(raw?.controlface?.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function listListeningPidsForPort(port) {
  if (!Number.isInteger(port) || port <= 0) return [];
  try {
    const stdout = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const target = `:${port}`;
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING') || !line.includes(target)) continue;
      const parts = line.trim().split(/\s+/);
      const localAddress = parts[1] || '';
      const state = parts[3] || '';
      const pid = Number(parts[4]);
      if (!localAddress.endsWith(target) || state !== 'LISTENING' || !Number.isInteger(pid) || pid <= 0) continue;
      pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

function forceKillPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try {
      process.kill(pid);
    } catch {
      // best-effort cleanup
    }
  }
}

function stopExistingProcesses() {
  const current = readPidFile();
  for (const pid of Object.values(current)) {
    if (!isRunning(pid)) continue;
    forceKillPid(pid);
  }

  const configuredPort = readConfiguredControlfacePort();
  for (const pid of listListeningPidsForPort(configuredPort)) {
    forceKillPid(pid);
  }
}

function spawnRuntime(entryFile) {
  const child = spawn(process.execPath, [entryFile, '--config', './hosted-board-runtime.localfs.config.json'], {
    cwd: runtimeRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

stopExistingProcesses();

const pids = {
  controlface: spawnRuntime('./http-mcp-controlface/controlface-server.js'),
  queueRunner: spawnRuntime('./queue-runner/queue-runner.js'),
};

fs.writeFileSync(pidFilePath, `${JSON.stringify(pids, null, 2)}\n`, 'utf8');
console.log(`started localfs hosted runtime: controlface=${pids.controlface} queueRunner=${pids.queueRunner}`);