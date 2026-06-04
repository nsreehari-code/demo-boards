#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const pidFilePath = path.join(runtimeRoot, '.runtime-pids.json');
const localfsConfigFilePath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');

function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
  } catch {
    return {};
  }
}

function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

function readConfiguredControlfacePort() {
  try {
    const raw = JSON.parse(fs.readFileSync(localfsConfigFilePath, 'utf8'));
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

const current = readPidFile();
const stopped = Object.entries(current)
  .filter(([, pid]) => stopPid(pid))
  .map(([name, pid]) => `${name}=${pid}`);

const configuredPort = readConfiguredControlfacePort();
const staleListenerPids = listListeningPidsForPort(configuredPort).filter((pid) => !Object.values(current).includes(pid));
for (const pid of staleListenerPids) {
  stopPid(pid);
}

try {
  fs.unlinkSync(pidFilePath);
} catch {
  // best-effort cleanup
}

const stoppedSummary = [
  ...stopped,
  ...staleListenerPids.map((pid) => `stale-controlface=${pid}`),
];

console.log(stoppedSummary.length > 0 ? `stopped hosted runtime: ${stoppedSummary.join(' ')}` : 'stopped hosted runtime: none');