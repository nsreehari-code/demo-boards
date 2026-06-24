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

function runCopilotNodeSmoke(tmpDir) {
  const runnerPath = path.join(
    repoRoot,
    'demo-board',
    'server',
    'lib',
    'copilot-cli.js',
  );
  ensureFileExists(runnerPath);

  const promptFile = path.join(tmpDir, 'copilot-node.prompt.txt');
  const outputFile = path.join(tmpDir, 'copilot-node.out.txt');

  fs.writeFileSync(promptFile, `${query}\n`, 'utf-8');

  const args = [
    runnerPath,
    '--output-file',
    outputFile,
    '--cwd',
    repoRoot,
    '--prompt-file',
    promptFile,
  ];

  const result = run(process.execPath, args);
  assertSuccess(result, 'copilot-cli.js');

  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8').trim() : '';
  if (!output) {
    throw new Error('copilot-cli.js produced no output');
  }
  assertContainsFour(output, 'copilot-cli.js');
  console.log('OK  copilot-cli.js query smoke check passed');
}

function smokeWorkiqCliInstall() {
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
      runCopilotNodeSmoke(tmpDir);
    } else if (mode === 'workiq') {
      console.log('Running WorkIQ CLI setup smoke check...');
      smokeWorkiqCliInstall();
    } else {
      console.log('Running Copilot + WorkIQ CLI setup smoke checks...');
      runCopilotNodeSmoke(tmpDir);
      smokeWorkiqCliInstall();
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
