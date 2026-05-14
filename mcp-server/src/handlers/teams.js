import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const value = args?.[key];
    if (value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function resolveTeamsCliPath() {
  const candidate = path.resolve(__dirname, '..', '..', '..', 'demo-board', 'scripts', 'zoltbook', 'cli.py');
  if (!fs.existsSync(candidate)) {
    throw new Error(`Teams CLI not found at: ${candidate}`);
  }
  return candidate;
}

function resolveDemoBoardRoot() {
  return path.resolve(__dirname, '..', '..', '..', 'demo-board');
}

function normalizeBooleanFlag(value) {
  return value === true || value === 'true';
}

function buildCliArgs(args) {
  const action = typeof args?.action === 'string' ? args.action.trim() : '';
  if (!action) {
    throw new Error('teams.graph requires a non-empty action');
  }

  const context = {
    ...((args?.args && typeof args.args === 'object') ? args.args : {}),
  };

  const cliArgs = [action];
  const teamId = args?.team_id ? interpolate(args.team_id, context) : '';
  const channelId = args?.channel_id ? interpolate(args.channel_id, context) : '';
  const teamName = args?.team_name ? interpolate(args.team_name, context) : '';
  const channelName = args?.channel_name ? interpolate(args.channel_name, context) : '';

  if (teamId) cliArgs.push('--team-id', teamId);
  if (channelId) cliArgs.push('--channel-id', channelId);
  if (teamName) cliArgs.push('--team-name', teamName);
  if (channelName) cliArgs.push('--channel-name', channelName);
  if (args?.top !== undefined) cliArgs.push('--top', String(args.top));
  if (args?.content) cliArgs.push('--content', interpolate(args.content, context));
  if (args?.content_type) cliArgs.push('--content-type', String(args.content_type));
  if (args?.subject) cliArgs.push('--subject', interpolate(args.subject, context));
  if (args?.message_id) cliArgs.push('--message-id', interpolate(args.message_id, context));
  if (args?.query) cliArgs.push('--query', interpolate(args.query, context));
  if (args?.agent_name) cliArgs.push('--agent-name', interpolate(args.agent_name, context));
  if (args?.agent_icon) cliArgs.push('--agent-icon', String(args.agent_icon));
  if (args?.reaction_type) cliArgs.push('--reaction-type', String(args.reaction_type));
  if (normalizeBooleanFlag(args?.unanswered_only)) cliArgs.push('--unanswered-only');
  if (normalizeBooleanFlag(args?.refresh)) cliArgs.push('--refresh');

  return cliArgs;
}

function runTeamsCli(args, timeoutMs) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const cliPath = resolveTeamsCliPath();
  const cwd = resolveDemoBoardRoot();
  const cliArgs = buildCliArgs(args);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(python, [cliPath, ...cliArgs], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`teams.graph timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `teams.graph exited ${code}`));
        return;
      }

      const text = stdout.trim();
      try {
        resolve(text ? JSON.parse(text) : []);
      } catch (err) {
        reject(new Error(`teams.graph returned invalid JSON: ${String(err?.message || err)}`));
      }
    });
  });
}

export async function handleTeamsGraph(args) {
  const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : 120_000;
  const result = await runTeamsCli(args, timeoutMs);
  return {
    content: [
      {
        type: 'text',
        text: Array.isArray(result) ? `Returned ${result.length} record(s)` : 'Returned Teams Graph result',
      },
    ],
    structuredContent: {
      result,
    },
  };
}