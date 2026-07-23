import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  COPILOT_MODEL,
  COPILOT_TIMEOUT_MS,
  runCopilot,
  spawnCopilot,
} from '../../../demo-board/server/lib/copilot-cli.js';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEMO_BOARDS_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(DEMO_BOARDS_ROOT, '..');
const LORE_ROOT_DIR = path.resolve(DEMO_BOARDS_ROOT, '..', 'mcp-server-managed-truthsets', 'lore');
const LORE_STORE_PATH = path.join(LORE_ROOT_DIR, 'lib', 'lore-store.cjs');
const SOURCE_ROOTS_SCOPE = 'app/copilot-c2';
const SOURCE_ROOTS_KEY = 'source-roots';
const COPILOT_RUNS = new Map();
const MAX_COMPLETED_RUNS = 50;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function repoRelative(targetPath) {
  return path.relative(WORKSPACE_ROOT, targetPath).replace(/\\/g, '/');
}

function isoNow() {
  return new Date().toISOString();
}

function asTextResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRunMode(value) {
  return normalizeOptionalString(value).toLowerCase() === 'async' ? 'async' : 'sync';
}

function ensureExistingDir(candidate, label) {
  const value = normalizeOptionalString(candidate);
  if (!value) return '';
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${resolved}`);
  }
  return resolved;
}

function ensureExistingFile(candidate, label) {
  const value = normalizeOptionalString(candidate);
  if (!value) throw new Error(`${label} must be a non-empty file path`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${resolved}`);
  }
  return resolved;
}

function parseAgentFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const parts = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!parts) continue;
    let value = parts[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[parts[1]] = value;
  }
  return result;
}

function normalizeSourceRootId(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
}

function normalizeSourceRootRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const resolvedPath = ensureExistingDir(entry.path, 'source root path');
  if (!resolvedPath) return null;
  const id = normalizeSourceRootId(entry.id || path.basename(resolvedPath));
  if (!id) throw new Error(`Unable to derive source root id for ${resolvedPath}`);
  return {
    id,
    label: normalizeOptionalString(entry.label) || id,
    path: resolvedPath,
    enabled: entry.enabled !== false,
  };
}

function loadLoreStore() {
  delete require.cache[require.resolve(LORE_STORE_PATH)];
  return require(LORE_STORE_PATH);
}

function loadSourceRoots() {
  const store = loadLoreStore();
  const entry = store.get(LORE_ROOT_DIR, SOURCE_ROOTS_SCOPE, SOURCE_ROOTS_KEY);
  const roots = Array.isArray(entry?.value) ? entry.value : [];
  return roots
    .map((entry) => normalizeSourceRootRecord(entry))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function saveSourceRoots(roots) {
  const store = loadLoreStore();
  const normalized = roots
    .map((entry) => normalizeSourceRootRecord(entry))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.length === 0) {
    try {
      store.remove(LORE_ROOT_DIR, SOURCE_ROOTS_SCOPE, SOURCE_ROOTS_KEY);
    } catch (error) {
      if (!error || error.code !== 'lore_not_found') throw error;
    }
    return normalized;
  }
  store.set(LORE_ROOT_DIR, SOURCE_ROOTS_SCOPE, SOURCE_ROOTS_KEY, normalized);
  return normalized;
}

function isAgentsDirectory(candidate) {
  return path.basename(candidate) === 'agents' && path.basename(path.dirname(candidate)) === '.github';
}

function resolveConfiguredAgentsDir(candidate) {
  const resolved = ensureExistingDir(candidate, 'source root path');
  if (!resolved) return '';
  if (isAgentsDirectory(resolved)) return resolved;
  return nearestProjectAgentsDir(resolved);
}

function nearestProjectAgentsDir(startDir) {
  let current = ensureExistingDir(startDir || WORKSPACE_ROOT, 'cwd') || WORKSPACE_ROOT;
  while (true) {
    const candidate = path.join(current, '.github', 'agents');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function collectAgentDirectories(cwd) {
  const dirs = [];
  const workspaceAgents = path.join(WORKSPACE_ROOT, '.github', 'agents');
  if (fs.existsSync(workspaceAgents)) dirs.push(workspaceAgents);
  const nearest = nearestProjectAgentsDir(cwd || WORKSPACE_ROOT);
  if (nearest && !dirs.includes(nearest)) dirs.push(nearest);
  for (const sourceRoot of loadSourceRoots()) {
    if (sourceRoot.enabled === false) continue;
    const configured = resolveConfiguredAgentsDir(sourceRoot.path);
    if (configured && !dirs.includes(configured)) dirs.push(configured);
  }
  const userAgents = path.join(os.homedir(), '.copilot', 'agents');
  if (fs.existsSync(userAgents)) dirs.push(userAgents);
  return dirs;
}

function listAgents(cwd) {
  const agents = new Map();
  for (const dir of collectAgentDirectories(cwd)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.agent.md'));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const stem = entry.name.slice(0, -'.agent.md'.length);
      const frontmatter = parseAgentFrontmatter(fs.readFileSync(absolutePath, 'utf8'));
      agents.set(stem, {
        id: stem,
        name: frontmatter.name || stem,
        description: frontmatter.description || '',
        argumentHint: frontmatter['argument-hint'] || '',
        userInvocable: frontmatter['user-invocable'] === 'true',
        source: dir.includes(path.join('.copilot', 'agents')) ? 'user' : 'project',
        path: absolutePath,
        relativePath: repoRelative(absolutePath),
      });
    }
  }
  return [...agents.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function probeCopilotCli() {
  const command = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    ok: !result.error && result.status === 0,
    error: result.error ? result.error.message : (result.status === 0 ? '' : `copilot exited ${result.status}`),
    supportsAgentFlag: /--agent\s+<agent>/.test(output),
    supportsContinue: /--continue/.test(output),
    supportsResume: /--resume/.test(output),
    supportsSessionId: /--session-id/.test(output),
    supportsSessionName: /--name\s+<name>/.test(output),
    supportsAttachments: /--attachment\s+<path>/.test(output),
    supportsReasoningEffort: /--(?:effort|reasoning-effort)/.test(output),
    supportsStopTool: /--cancel\b|\bstop\b/i.test(output),
    command,
  };
}

function buildPrompt(message, agent, invocationMode) {
  if (!agent || invocationMode === 'flag') return message;
  return `Use the ${agent} agent for this task.\n\n${message}`;
}

function summarizeOutput(stdout, stderr) {
  const output = (stdout || '').trim();
  const errorOutput = (stderr || '').trim();
  return output || errorOutput || '(Copilot produced no output yet)';
}

function serializableRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cwd: run.cwd,
    addDirs: run.addDirs,
    attachments: run.attachments,
    agent: run.agent,
    model: run.model,
    sessionId: run.sessionId,
    continueSession: run.continueSession,
    resumeSession: run.resumeSession,
    sessionName: run.sessionName,
    reasoningEffort: run.reasoningEffort,
    timeoutMs: run.timeoutMs,
    invocationMode: run.invocationMode,
    promptPreview: run.promptPreview,
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    error: run.error,
    cancellationRequested: run.cancellationRequested,
    timeoutRequested: run.timeoutRequested,
    pid: run.pid,
  };
}

function listRunRecords() {
  return [...COPILOT_RUNS.values()]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function trimCompletedRuns() {
  const completed = listRunRecords().filter((run) => run.status !== 'running');
  for (const run of completed.slice(MAX_COMPLETED_RUNS)) {
    COPILOT_RUNS.delete(run.id);
  }
}

function createRunRecord(config) {
  const now = isoNow();
  const run = {
    id: randomUUID(),
    status: 'running',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    cwd: config.cwd,
    addDirs: config.addDirs,
    attachments: config.attachments,
    agent: config.agent,
    model: config.model,
    sessionId: config.sessionId,
    continueSession: config.continueSession,
    resumeSession: config.resumeSession,
    sessionName: config.sessionName,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    invocationMode: config.invocationMode,
    promptPreview: config.prompt.slice(0, 4000),
    stdout: '',
    stderr: '',
    exitCode: null,
    error: '',
    cancellationRequested: false,
    timeoutRequested: false,
    pid: null,
    child: null,
    timeout: null,
  };
  COPILOT_RUNS.set(run.id, run);
  trimCompletedRuns();
  return run;
}

function finalizeRun(run, patch = {}) {
  if (run.finishedAt) return run;
  if (run.timeout) clearTimeout(run.timeout);
  Object.assign(run, patch, {
    finishedAt: patch.finishedAt ?? isoNow(),
    child: null,
    timeout: null,
  });
  trimCompletedRuns();
  return run;
}

function terminateRunProcess(run) {
  if (!run.child) return false;
  if (process.platform === 'win32' && typeof run.pid === 'number') {
    const result = spawnSync('taskkill', ['/pid', String(run.pid), '/t', '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    return result.status === 0;
  }
  return run.child.kill('SIGTERM');
}

function buildRunSummary(run) {
  return run.status === 'running'
    ? `Copilot run ${run.id} is running.`
    : `Copilot run ${run.id} ${run.status}${run.exitCode === null ? '' : ` (exit ${run.exitCode})`}.`;
}

function projectRootForAgent(agent) {
  if (agent?.source !== 'project' || !agent.path) return '';
  return path.dirname(path.dirname(path.dirname(agent.path)));
}

export function prepareRunArguments(args) {
  const message = normalizeOptionalString(args?.message);
  if (!message) throw new Error('copilot.run_agent requires a non-empty message');

  const invocationMode = normalizeOptionalString(args?.invocationMode).toLowerCase() || 'flag';
  if (!['flag', 'prompt'].includes(invocationMode)) {
    throw new Error(`Unsupported invocationMode '${args?.invocationMode}'. Expected 'flag' or 'prompt'.`);
  }

  const requestedCwd = ensureExistingDir(args?.cwd || WORKSPACE_ROOT, 'cwd') || WORKSPACE_ROOT;
  let cwd = requestedCwd;
  const addDirs = Array.isArray(args?.addDirs)
    ? args.addDirs.map((entry) => ensureExistingDir(entry, 'addDirs entry')).filter(Boolean)
    : [];
  const attachments = Array.isArray(args?.attachments)
    ? args.attachments.map((entry) => ensureExistingFile(entry, 'attachments entry'))
    : [];
  const agent = normalizeOptionalString(args?.agent);
  if (agent) {
    const selectedAgent = listAgents(requestedCwd).find((entry) => entry.id === agent);
    if (!selectedAgent) {
      throw new Error(`Unknown local Copilot agent '${agent}' for cwd ${requestedCwd}`);
    }
    if (!normalizeOptionalString(args?.cwd)) {
      cwd = projectRootForAgent(selectedAgent) || requestedCwd;
    }
  }

  const sessionId = normalizeOptionalString(args?.sessionId) || null;
  const continueSession = args?.continueSession === true;
  const resumeSession = normalizeOptionalString(args?.resumeSession) || null;
  const sessionName = normalizeOptionalString(args?.sessionName) || null;
  const activeSessionModes = [Boolean(sessionId), continueSession, Boolean(resumeSession)].filter(Boolean).length;
  if (activeSessionModes > 1) {
    throw new Error('sessionId, continueSession, and resumeSession are mutually exclusive');
  }
  if (sessionName && activeSessionModes > 0) {
    throw new Error('sessionName can only be used when starting a new session');
  }

  return {
    runMode: normalizeRunMode(args?.runMode),
    cwd,
    addDirs,
    attachments,
    agent: agent || null,
    invocationMode,
    prompt: buildPrompt(message, agent, invocationMode),
    model: normalizeOptionalString(args?.model) || COPILOT_MODEL,
    sessionId,
    continueSession,
    resumeSession,
    sessionName,
    reasoningEffort: normalizeOptionalString(args?.reasoningEffort) || null,
    timeoutMs: Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : COPILOT_TIMEOUT_MS,
  };
}

function startAsyncRun(config) {
  const run = createRunRecord(config);
  const child = spawnCopilot({
    prompt: config.prompt,
    workingDir: config.cwd,
    addDirs: config.addDirs,
    attachments: config.attachments,
    ...(config.agent && config.invocationMode === 'flag' ? { agent: config.agent } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    ...(config.continueSession ? { continueSession: true } : {}),
    ...(config.resumeSession ? { resumeSession: config.resumeSession } : {}),
    ...(config.sessionName ? { sessionName: config.sessionName } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });

  run.child = child;
  run.pid = child.pid ?? null;
  run.timeout = setTimeout(() => {
    if (run.status !== 'running') return;
    run.timeoutRequested = true;
    run.error = `Copilot run exceeded timeout of ${config.timeoutMs}ms`;
    try {
      terminateRunProcess(run);
    } catch (error) {
      finalizeRun(run, { status: 'failed', error: error?.message || String(error) });
    }
  }, config.timeoutMs);

  child.stdout.on('data', (chunk) => {
    run.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    run.stderr += chunk.toString();
  });
  child.on('error', (error) => {
    finalizeRun(run, {
      status: run.cancellationRequested ? 'cancelled' : 'failed',
      error: error?.message || String(error),
      exitCode: null,
    });
  });
  child.on('close', (code, signal) => {
    const cancelled = run.cancellationRequested || signal === 'SIGTERM' || signal === 'SIGKILL';
    finalizeRun(run, {
      status: run.timeoutRequested ? 'timed_out' : (cancelled ? 'cancelled' : (code === 0 ? 'completed' : 'failed')),
      exitCode: typeof code === 'number' ? code : null,
    });
  });

  return run;
}

async function handleCheckEnvironment(args) {
  const cwd = normalizeOptionalString(args?.cwd) || WORKSPACE_ROOT;
  const probe = probeCopilotCli();
  const agents = listAgents(cwd);
  const structured = {
    cwd: path.resolve(cwd),
    command: probe.command,
    cli: {
      ok: probe.ok,
      supportsAgentFlag: probe.supportsAgentFlag,
      supportsContinue: probe.supportsContinue,
      supportsResume: probe.supportsResume,
      supportsSessionId: probe.supportsSessionId,
      supportsSessionName: probe.supportsSessionName,
      supportsAttachments: probe.supportsAttachments,
      supportsReasoningEffort: probe.supportsReasoningEffort,
      supportsStopTool: probe.supportsStopTool,
      note: probe.supportsStopTool
        ? 'CLI help advertises explicit stop or cancel support.'
        : 'CLI help does not advertise a dedicated stop or cancel command; host-side process termination remains the fallback.',
      error: probe.error || undefined,
    },
    agentCount: agents.length,
    agents,
  };
  const summary = probe.ok
    ? `Copilot CLI is available. Found ${agents.length} local custom agent(s).`
    : `Copilot CLI probe failed: ${probe.error || 'unknown error'}`;
  return asTextResult(summary, structured);
}

async function handleListAgents(args) {
  const cwd = normalizeOptionalString(args?.cwd) || WORKSPACE_ROOT;
  const agents = listAgents(cwd);
  const summary = agents.length === 0
    ? 'No local Copilot custom agents were found.'
    : agents.map((agent) => `- ${agent.id}: ${agent.description || 'no description'}`).join('\n');
  return asTextResult(summary, {
    cwd: path.resolve(cwd),
    count: agents.length,
    agents,
  });
}

async function handleListSourceRoots() {
  const roots = loadSourceRoots();
  return asTextResult(
    roots.length === 0
      ? 'No configured Copilot source roots.'
      : roots.map((root) => `- ${root.id}: ${root.path}`).join('\n'),
    {
      count: roots.length,
      roots: cloneJson(roots),
    }
  );
}

async function handleUpsertSourceRoot(args) {
  const resolvedPath = ensureExistingDir(args?.path, 'path');
  const nextRoot = normalizeSourceRootRecord({
    id: normalizeSourceRootId(args?.id) || path.basename(resolvedPath),
    label: args?.label,
    path: resolvedPath,
    enabled: args?.enabled,
  });
  const roots = loadSourceRoots();
  const index = roots.findIndex((entry) => entry.id === nextRoot.id);
  const saved = saveSourceRoots(
    index >= 0
      ? roots.map((entry, entryIndex) => (entryIndex === index ? nextRoot : entry))
      : [...roots, nextRoot]
  );
  return asTextResult(
    index >= 0
      ? `Updated Copilot source root ${nextRoot.id}.`
      : `Added Copilot source root ${nextRoot.id}.`,
    {
      root: cloneJson(nextRoot),
      count: saved.length,
      roots: cloneJson(saved),
      created: index < 0,
    }
  );
}

async function handleRemoveSourceRoot(args) {
  const rootId = normalizeSourceRootId(args?.id);
  if (!rootId) throw new Error('copilot.remove_source_root requires id');
  const roots = loadSourceRoots();
  const existing = roots.find((entry) => entry.id === rootId);
  if (!existing) throw new Error(`Unknown Copilot source root '${rootId}'`);
  const saved = saveSourceRoots(roots.filter((entry) => entry.id !== rootId));
  return asTextResult(
    `Removed Copilot source root ${rootId}.`,
    {
      removed: cloneJson(existing),
      count: saved.length,
      roots: cloneJson(saved),
    }
  );
}

async function handleRunAgent(args) {
  const config = prepareRunArguments(args);
  if (config.runMode === 'async') {
    const run = startAsyncRun(config);
    return asTextResult(`Started Copilot run ${run.id}.`, {
      run: serializableRun(run),
    });
  }

  const { code, stdout, stderr } = await runCopilot({
    prompt: config.prompt,
    workingDir: config.cwd,
    addDirs: config.addDirs,
    attachments: config.attachments,
    ...(config.agent && config.invocationMode === 'flag' ? { agent: config.agent } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    ...(config.continueSession ? { continueSession: true } : {}),
    ...(config.resumeSession ? { resumeSession: config.resumeSession } : {}),
    ...(config.sessionName ? { sessionName: config.sessionName } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(Number.isFinite(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
  });

  const output = (stdout || '').trim();
  const errorOutput = (stderr || '').trim();
  if (code !== 0) {
    throw new Error(`Copilot CLI exited ${code}${errorOutput ? `: ${errorOutput}` : output ? `: ${output}` : ''}`);
  }

  return asTextResult(output || '(Copilot returned no stdout)', {
    code,
    cwd: config.cwd,
    addDirs: config.addDirs,
    attachments: config.attachments,
    agent: config.agent,
    invocationMode: config.invocationMode,
    model: config.model,
    sessionId: config.sessionId,
    continueSession: config.continueSession,
    resumeSession: config.resumeSession,
    sessionName: config.sessionName,
    reasoningEffort: config.reasoningEffort,
    stdout,
    stderr,
  });
}

async function handleListRuns() {
  const runs = listRunRecords().map(serializableRun);
  const summary = runs.length === 0
    ? 'No Copilot runs have been started in this server process.'
    : runs.map((run) => `- ${run.id}: ${run.status}${run.agent ? ` (${run.agent})` : ''}`).join('\n');
  return asTextResult(summary, {
    count: runs.length,
    runs,
  });
}

async function handleGetRun(args) {
  const runId = normalizeOptionalString(args?.runId);
  if (!runId) throw new Error('copilot.get_run requires runId');
  const run = COPILOT_RUNS.get(runId);
  if (!run) throw new Error(`Unknown Copilot run '${runId}'`);
  return asTextResult(buildRunSummary(run), {
    run: serializableRun(run),
    outputPreview: summarizeOutput(run.stdout, run.stderr),
  });
}

async function handleCancelRun(args) {
  const runId = normalizeOptionalString(args?.runId);
  if (!runId) throw new Error('copilot.cancel_run requires runId');
  const run = COPILOT_RUNS.get(runId);
  if (!run) throw new Error(`Unknown Copilot run '${runId}'`);
  if (run.status !== 'running' || !run.child) {
    return asTextResult(`Copilot run ${runId} is already ${run.status}.`, {
      run: serializableRun(run),
    });
  }

  run.cancellationRequested = true;
  run.error = 'Cancelled by MCP host request';

  let killed = false;
  try {
    killed = terminateRunProcess(run);
  } catch (error) {
    throw new Error(`Unable to cancel Copilot run ${runId}: ${error.message}`);
  }

  return asTextResult(
    killed ? `Cancellation requested for Copilot run ${runId}.` : `Copilot run ${runId} did not acknowledge cancellation immediately.`,
    {
      run: serializableRun(run),
    }
  );
}

export async function handleCopilotTool(args, tool) {
  switch (tool.name) {
    case 'copilot.check_environment':
      return handleCheckEnvironment(args);
    case 'copilot.list_agents':
      return handleListAgents(args);
    case 'copilot.list_source_roots':
      return handleListSourceRoots(args);
    case 'copilot.upsert_source_root':
      return handleUpsertSourceRoot(args);
    case 'copilot.remove_source_root':
      return handleRemoveSourceRoot(args);
    case 'copilot.run_agent':
      return handleRunAgent(args);
    case 'copilot.list_runs':
      return handleListRuns(args);
    case 'copilot.get_run':
      return handleGetRun(args);
    case 'copilot.cancel_run':
      return handleCancelRun(args);
    default:
      throw new Error(`Unsupported Copilot MCP tool: ${tool.name}`);
  }
}