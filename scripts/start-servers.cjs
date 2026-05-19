#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const workspaceDir = path.resolve(__dirname, '..');
const tempDir = path.join(workspaceDir, '.tmp');
const logDir = path.join(tempDir, 'server-logs');
const pidFile = path.join(tempDir, 'server-processes.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmExecPath = typeof process.env.npm_execpath === 'string' && process.env.npm_execpath
  ? process.env.npm_execpath
  : '';
const httpServerCli = require.resolve('http-server/bin/http-server');
const isDevMode = process.argv.includes('--dev');
const label = isDevMode ? 'dev:servers' : 'start:servers';

function getExpectedEndpoint(name) {
  if (name === 'board-server') {
    return 'http://127.0.0.1:7799';
  }

  if (name === 'mcp-server') {
    return 'http://127.0.0.1:7801/mcp';
  }

  if (name === 'vite') {
    return 'http://127.0.0.1:5510';
  }

  if (name === 'frontend') {
    return 'http://127.0.0.1:8000';
  }

  return 'n/a';
}

function createNpmProcess(name, args) {
  if (npmExecPath) {
    return {
      name,
      command: process.execPath,
      args: [npmExecPath, ...args],
      cwd: workspaceDir,
    };
  }

  return {
    name,
    command: npmCmd,
    args,
    cwd: workspaceDir,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function readExistingState() {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
  } catch {
    return null;
  }
}

function getLiveProcesses(state) {
  if (!state || !Array.isArray(state.processes)) {
    return [];
  }

  return state.processes.filter((entry) => isPidAlive(entry.pid));
}

function spawnDetachedProcess(definition) {
  const logPath = path.join(logDir, `${definition.name}.log`);
  const errorLogPath = path.join(logDir, `${definition.name}.err.log`);

  let command = definition.command;
  let args = definition.args;

  // On Windows, .cmd/.bat files must be wrapped in cmd.exe so that windowsHide:true
  // suppresses the console window. Using shell:true is unreliable with detached processes.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    args = ['/d', '/c', command, ...args];
    command = process.env.COMSPEC || 'cmd.exe';
  }

  const outFd = fs.openSync(logPath, 'a');
  const errFd = fs.openSync(errorLogPath, 'a');

  const child = spawn(command, args, {
    cwd: definition.cwd,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, FORCE_COLOR: '1' },
    windowsHide: true,
  });

  fs.closeSync(outFd);
  fs.closeSync(errFd);
  child.unref();

  return {
    name: definition.name,
    pid: child.pid,
    logPath: path.relative(workspaceDir, logPath).replace(/\\/g, '/'),
    errorLogPath: path.relative(workspaceDir, errorLogPath).replace(/\\/g, '/'),
    command: definition.command,
    args: definition.args,
    cwd: path.relative(workspaceDir, definition.cwd).replace(/\\/g, '/'),
  };
}

ensureDir(tempDir);
ensureDir(logDir);

const existingState = readExistingState();
const liveProcesses = getLiveProcesses(existingState);
if (liveProcesses.length > 0) {
  console.error(`[${label}] Servers already appear to be running:`);
  for (const processInfo of liveProcesses) {
    console.error(`- ${processInfo.name} (pid ${processInfo.pid})`);
  }
  console.error(`[${label}] Run "npm run stop:servers" first if you want to restart them.`);
  process.exit(1);
}

const frontendProcess = isDevMode
  ? createNpmProcess('vite', ['--prefix', path.join('demo-board', 'web', 'vite'), 'run', 'dev'])
  : {
      name: 'frontend',
      command: process.execPath,
      args: [httpServerCli, 'demo-board', '-p', '8000', '-c-1'],
      cwd: workspaceDir,
    };

const processes = [
  createNpmProcess('mcp-server', ['--prefix', 'mcp-server', 'run', 'start:http']),
  {
    name: 'board-server',
    command: process.execPath,
    args: [path.join('scripts', 'start-server.cjs'), 'demo-board', '--backend'],
    cwd: workspaceDir,
  },
  frontendProcess,
];

const startedProcesses = processes.map(spawnDetachedProcess);
const state = {
  startedAt: new Date().toISOString(),
  mode: isDevMode ? 'dev' : 'built',
  processes: startedProcesses,
};

fs.writeFileSync(pidFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');

console.log(`[${label}] Started services:`);
for (const processInfo of startedProcesses) {
  console.log(
    `- ${processInfo.name}: pid ${processInfo.pid}, endpoint ${getExpectedEndpoint(processInfo.name)}, log ${processInfo.logPath}`
  );
}
console.log(`[${label}] Expected endpoints:`);
console.log('- board-server: http://127.0.0.1:7799');
console.log('- mcp-server:   http://127.0.0.1:7801/mcp');
console.log(isDevMode
  ? '- vite:         http://127.0.0.1:5510'
  : '- frontend:     http://127.0.0.1:8000');