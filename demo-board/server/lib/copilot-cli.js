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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const COPILOT_MODEL = 'gpt-5.4';
export const COPILOT_TIMEOUT_MS = 300_000;

export function buildCopilotCommand(opts = {}) {
  const {
    workingDir,
    addDirs = [],
    attachments = [],
    agent,
    model = COPILOT_MODEL,
    sessionId,
    continueSession = false,
    resumeSession,
    sessionName,
    reasoningEffort,
    availableTools,
    additionalMcpConfigs = [],
  } = opts;

  const sessionModes = [continueSession, Boolean(sessionId), Boolean(resumeSession)]
    .filter(Boolean).length;
  if (sessionModes > 1) {
    throw new Error('continueSession, sessionId, and resumeSession are mutually exclusive');
  }
  if (sessionName && sessionModes > 0) {
    throw new Error('sessionName can only be used when starting a new session');
  }

  const onWindows = process.platform === 'win32';
  const args = [];
  if (workingDir) args.push('-C', workingDir);
  if (agent) args.push('--agent', agent);
  if (continueSession) args.push('--continue');
  if (sessionId) args.push('--session-id', sessionId);
  if (typeof resumeSession === 'string' && resumeSession) args.push(`--resume=${resumeSession}`);
  if (sessionName) args.push('--name', sessionName);
  if (reasoningEffort) args.push('--effort', reasoningEffort);
  args.push('-s', '--no-ask-user', '--allow-all-tools', '--model', model);
  if (Array.isArray(availableTools) && availableTools.length > 0) {
    args.push(`--available-tools=${availableTools.join(',')}`);
  }
  for (const config of additionalMcpConfigs) {
    args.push('--additional-mcp-config', config);
  }
  if (onWindows) args.push('--deny-tool', 'shell');
  for (const dir of addDirs) args.push('--add-dir', dir);
  for (const attachment of attachments) args.push('--attachment', attachment);

  return {
    command: onWindows ? 'copilot.exe' : 'copilot',
    args,
  };
}

export function spawnCopilot(opts = {}) {
  const { prompt = '', workingDir } = opts;
  const { command, args } = buildCopilotCommand(opts);
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: workingDir || undefined,
    env: process.env,
  });
  child.stdin.end(prompt);
  return child;
}

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
 * @param {string[]} [opts.attachments]   Initial prompt attachments (`--attachment`).
 * @param {string} [opts.agent]           Custom agent id (`--agent`).
 * @param {string} [opts.model]           Model id (default COPILOT_MODEL).
 * @param {string} [opts.sessionId]       Native session id (`--session-id`).
 * @param {boolean} [opts.continueSession] Resume the most recent session (`--continue`).
 * @param {string} [opts.resumeSession] Resume by id, prefix, task id, or exact name (`--resume`).
 * @param {string} [opts.sessionName]      Name a newly created session (`--name`).
 * @param {string} [opts.reasoningEffort]  Native reasoning effort level (`--effort`).
 * @param {number} [opts.timeoutMs]       Kill the process after this many ms.
 * @param {(chunk: string) => void} [opts.onData] Live stdout chunk callback.
 */
export function runCopilot(opts = {}) {
  const {
    prompt = '',
    workingDir,
    addDirs = [],
    attachments = [],
    agent,
    model = COPILOT_MODEL,
    sessionId,
    continueSession = false,
    resumeSession,
    sessionName,
    reasoningEffort,
    availableTools = [],
    additionalMcpConfigs = [],
    timeoutMs = COPILOT_TIMEOUT_MS,
    onData,
  } = opts;
  const spawnProcess = opts.spawnProcess ?? spawnCopilot;
  const terminateProcess = opts.terminateProcess ?? terminateCopilotProcess;

  return new Promise((resolve, reject) => {
    const child = spawnProcess({
      prompt,
      workingDir,
      addDirs,
      attachments,
      agent,
      model,
      sessionId,
      continueSession,
      resumeSession,
      sessionName,
      reasoningEffort,
      availableTools,
      additionalMcpConfigs,
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

    timer = setTimeout(() => {
      const timeoutMessage = `Copilot CLI timed out after ${timeoutMs}ms`;
      try {
        terminateProcess(child);
      } catch (error) {
        stderr += `${stderr ? '\n' : ''}${timeoutMessage}; termination failed: ${error?.message || String(error)}`;
        finish(() => resolve({ code: 124, stdout, stderr, timedOut: true }));
        return;
      }
      stderr += `${stderr ? '\n' : ''}${timeoutMessage}`;
      finish(() => resolve({ code: 124, stdout, stderr, timedOut: true }));
    }, timeoutMs);
  });
}

export function terminateCopilotProcess(child) {
  if (!child || typeof child.pid !== 'number') return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || `taskkill exited ${result.status}`).trim());
    }
    return true;
  }
  return child.kill('SIGKILL');
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
      case '--agent': opts.agent = next(); break;
      case '--model': opts.model = next(); break;
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
    agent: opts.agent,
    sessionId: opts.sessionId,
    ...(opts.model ? { model: opts.model } : {}),
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
