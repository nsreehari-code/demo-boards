#!/usr/bin/env node

/**
 * teams-handler.js — Microsoft Graph API for Teams via Zoltbook Python CLI.
 *
 * Uses the current `az login` session (no app registration needed).
 * Shells out to: python scripts/zoltbook/cli.py <action> [flags]
 *
 * Supported actions:
 *   list-teams, list-channels, read-channel, get-threads,
 *   post-message, reply-to-message, search, set-reaction, remove-reaction
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const executorDir = context?.executorDir || process.cwd();

  const cfg = typeof sourceDef.teams === 'object' ? sourceDef.teams : {};
  const action = cfg.action;
  if (!action) {
    return { result: 'failure', data: { error: 'teams: action is required' }, error: 'missing action' };
  }

  const ctx = { ...(sourceDef._projections || {}), ...(cfg.args || {}) };
  const teamId      = interpolate(cfg.team_id      || '', ctx);
  const channelId   = interpolate(cfg.channel_id   || '', ctx);
  const teamName    = cfg.team_name    ? interpolate(cfg.team_name, ctx)    : '';
  const channelName = cfg.channel_name ? interpolate(cfg.channel_name, ctx) : '';

  const cliArgs = [action];
  if (teamId)      cliArgs.push('--team-id',      teamId);
  if (channelId)   cliArgs.push('--channel-id',   channelId);
  if (teamName)    cliArgs.push('--team-name',    teamName);
  if (channelName) cliArgs.push('--channel-name', channelName);

  if (cfg.top)            cliArgs.push('--top', String(cfg.top));
  if (cfg.content)        cliArgs.push('--content',      interpolate(cfg.content, ctx));
  if (cfg.content_type)   cliArgs.push('--content-type', cfg.content_type);
  if (cfg.subject)        cliArgs.push('--subject',      interpolate(cfg.subject, ctx));
  if (cfg.message_id)     cliArgs.push('--message-id',   interpolate(cfg.message_id, ctx));
  if (cfg.query)          cliArgs.push('--query',        interpolate(cfg.query, ctx));
  if (cfg.agent_name)     cliArgs.push('--agent-name',   interpolate(cfg.agent_name, ctx));
  if (cfg.agent_icon)     cliArgs.push('--agent-icon',   cfg.agent_icon);
  if (cfg.reaction_type)  cliArgs.push('--reaction-type', cfg.reaction_type);
  if (cfg.unanswered_only) cliArgs.push('--unanswered-only');
  if (cfg.refresh)        cliArgs.push('--refresh');

  const python = process.platform === 'win32' ? 'python' : 'python3';
  const cliPath = path.join(executorDir, 'scripts', 'zoltbook', 'cli.py');

  try {
    const raw = execFileSync(python, [cliPath, ...cliArgs], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      cwd: executorDir,
    });
    const resultValue = raw.trim() ? JSON.parse(raw) : [];
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
    return { result: 'failure', data: { error: `teams/${action}: ${msg}` }, error: msg };
  }
}
