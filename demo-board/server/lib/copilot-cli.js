#!/usr/bin/env node
/**
 * Shared Copilot CLI invocation path for all board lanes (chat-flow + board-worker).
 *
 * This is intentionally minimal: it spawns the headless `copilot` CLI with the
 * standard sandbox flags and returns its output. Session continuity is delegated
 * to copilot's own native support (`--session-id` / `--continue`) — there is no
 * external lock or session-state shuffling here.
 *
 * CLI usage (used by the setup smoke check):
 *   node copilot-cli.js --prompt-file <p> --output-file <o> --cwd <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const COPILOT_MODEL = 'gpt-5.4';

/**
 * Spawn the headless copilot CLI. Prompt is piped via stdin.
 *
 * Resolves with `{ code, stdout, stderr }` (it does NOT reject on a non-zero
 * exit code — callers decide how to treat that). Rejects only if the process
 * fails to spawn.
 *
 * @param {object} opts
 * @param {string} [opts.prompt]          Prompt text, piped via stdin.
 * @param {string} [opts.workingDir]      Copilot working directory (`-C`).
 * @param {string[]} [opts.addDirs]       Extra dirs (`--add-dir`).
 * @param {string} [opts.model]           Model id (default COPILOT_MODEL).
 * @param {string} [opts.sessionId]       Native session id (`--session-id`).
 * @param {boolean} [opts.continueSession] Resume the most recent session (`--continue`).
 * @param {number} [opts.timeoutMs]       Kill the process after this many ms.
 * @param {(chunk: string) => void} [opts.onData] Live stdout chunk callback.
 */
export function runCopilot(opts = {}) {
  const {
    prompt = '',
    workingDir,
    addDirs = [],
    model = COPILOT_MODEL,
    sessionId,
    continueSession = false,
    timeoutMs = 300_000,
    onData,
  } = opts;

  return new Promise((resolve, reject) => {
    const onWindows = process.platform === 'win32';
    const args = [];
    if (workingDir) args.push('-C', workingDir);
    if (continueSession) args.push('--continue');
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-s', '--no-ask-user', '--allow-all-tools', '--model', model);
    if (onWindows) args.push('--deny-tool', 'shell');
    for (const dir of addDirs) args.push('--add-dir', dir);

    const command = onWindows ? 'copilot.exe' : 'copilot';
    const spawnArgs = args;

    const child = spawn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: workingDir || undefined,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      fn();
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onData) onData(text);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));

    timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point (used by the setup smoke check)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { addDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--prompt-file': opts.promptFile = next(); break;
      case '--prompt': opts.prompt = next(); break;
      case '--output-file': opts.outputFile = next(); break;
      case '--cwd': opts.workingDir = next(); break;
      case '--session-id': opts.sessionId = next(); break;
      case '--add-dir': opts.addDirs.push(next()); break;
      default: break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.outputFile) {
    console.error('copilot-cli: --output-file is required');
    return 2;
  }
  const prompt = opts.promptFile ? fs.readFileSync(opts.promptFile, 'utf-8') : (opts.prompt ?? '');
  const { code, stdout, stderr } = await runCopilot({
    prompt,
    workingDir: opts.workingDir,
    addDirs: opts.addDirs,
    sessionId: opts.sessionId,
  });
  const output = stderr ? `${stdout}\n${stderr}` : stdout;
  fs.writeFileSync(opts.outputFile, output, 'utf-8');
  return code === 0 ? 0 : (code ?? 1);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`copilot-cli: fatal: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}
