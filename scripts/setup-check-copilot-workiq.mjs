#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mode = process.argv.includes('--copilot-only')
  ? 'copilot'
  : process.argv.includes('--workiq-only')
    ? 'workiq'
    : 'all';

const query = 'Answer with only the number. What is two plus two?';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    timeout: options.timeout ?? 300000,
    input: options.input,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function assertSuccess(result, stepName) {
  if (result.error) {
    throw new Error(`${stepName} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(
      `${stepName} exited with code ${result.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

function assertContainsFour(text, stepName) {
  if (!/\b4\b/.test(text)) {
    throw new Error(`${stepName} did not include the expected answer 4. Output:\n${text}`);
  }
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected file not found: ${filePath}`);
  }
}

function resolveWorkiqCliPath() {
  const candidate = path.join(
    process.env.APPDATA || os.homedir(),
    'npm',
    'node_modules',
    '@microsoft',
    'workiq',
    'bin',
    'workiq.js',
  );
  ensureFileExists(candidate);
  return candidate;
}

function runCopilotBatSmoke(tmpDir) {
  if (process.platform !== 'win32') {
    throw new Error('copilot_wrapper.bat smoke check is only supported on Windows hosts');
  }

  const wrapperPath = path.join(repoRoot, 'demo-board', 'server', 'chat-flow', 'copilot-chat', 'copilot_wrapper.bat');
  ensureFileExists(wrapperPath);

  const promptFile = path.join(tmpDir, 'copilot-bat.prompt.txt');
  const outputFile = path.join(tmpDir, 'copilot-bat.out.txt');
  const errFile = path.join(tmpDir, 'copilot-bat.err.txt');

  fs.writeFileSync(promptFile, `${query}\n`, 'utf-8');
  fs.writeFileSync(outputFile, '', 'utf-8');
  fs.writeFileSync(errFile, '', 'utf-8');

  const result = run('cmd.exe', ['/d', '/s', '/c', wrapperPath, repoRoot, promptFile, outputFile, errFile]);
  assertSuccess(result, 'copilot_wrapper.bat');

  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8').trim() : '';
  const stderrText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
  const combined = `${output}\n${stderrText}`.trim();
  if (!combined) {
    throw new Error('copilot_wrapper.bat produced no output');
  }
  assertContainsFour(combined, 'copilot_wrapper.bat');
  console.log('OK  copilot_wrapper.bat query smoke check passed');
}

function resolvePythonCommand() {
  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'python', argsPrefix: [] },
        { cmd: 'py', argsPrefix: ['-3'] },
      ]
    : [
        { cmd: 'python3', argsPrefix: [] },
        { cmd: 'python', argsPrefix: [] },
      ];

  for (const candidate of candidates) {
    const probe = run(candidate.cmd, [...candidate.argsPrefix, '--version'], { timeout: 20000 });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function runCopilotPythonSmoke(tmpDir) {
  const wrapperPath = path.join(
    repoRoot,
    'demo-board',
    'server',
    'board-worker',
    'source-def-flows',
    'copilot-handler',
    'copilot-wrapper.py',
  );
  ensureFileExists(wrapperPath);

  const python = resolvePythonCommand();
  if (!python) {
    throw new Error('Could not find a Python interpreter (tried python/py -3)');
  }

  const promptFile = path.join(tmpDir, 'copilot-py.prompt.txt');
  const outputFile = path.join(tmpDir, 'copilot-py.out.txt');
  const sessionDir = path.join(tmpDir, 'copilot-py.session');

  fs.writeFileSync(promptFile, `${query}\n`, 'utf-8');
  fs.mkdirSync(sessionDir, { recursive: true });

  const args = [
    ...python.argsPrefix,
    wrapperPath,
    '--output-file',
    outputFile,
    '--session-dir',
    sessionDir,
    '--cwd',
    repoRoot,
    '--prompt-file',
    promptFile,
    '--result-type',
    'raw',
    '--agent-name',
    'setup-check',
  ];

  const result = run(python.cmd, args);
  assertSuccess(result, 'copilot-wrapper.py');

  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8').trim() : '';
  if (!output) {
    throw new Error('copilot-wrapper.py produced no output');
  }
  assertContainsFour(output, 'copilot-wrapper.py');
  console.log('OK  copilot-wrapper.py query smoke check passed');
}

function runWorkiqCliSmoke() {
  const workiqJs = resolveWorkiqCliPath();
  const result = run(process.execPath, [workiqJs, 'ask', '-q', query], {
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  assertSuccess(result, 'workiq ask');

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (!combined) {
    throw new Error('workiq ask produced no output');
  }
  assertContainsFour(combined, 'workiq ask');
  console.log('OK  workiq ask query smoke check passed');
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-boards-setup-check-'));
  try {
    if (mode === 'copilot') {
      console.log('Running Copilot wrapper setup smoke checks...');
      runCopilotBatSmoke(tmpDir);
      runCopilotPythonSmoke(tmpDir);
    } else if (mode === 'workiq') {
      console.log('Running WorkIQ CLI setup smoke check...');
      runWorkiqCliSmoke();
    } else {
      console.log('Running Copilot + WorkIQ CLI setup smoke checks...');
      runCopilotBatSmoke(tmpDir);
      runCopilotPythonSmoke(tmpDir);
      runWorkiqCliSmoke();
    }
    console.log('All setup checks passed.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}
