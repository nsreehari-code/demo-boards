#!/usr/bin/env node

/**
 * foundry-handler.js — Azure AI Foundry Agent invocation via Managed Identity.
 *
 * Shells out to scripts/foundry/invoke.py (uses azure-identity + azure-ai-inference).
 * No API keys needed — uses DefaultAzureCredential (MI in prod, az login locally).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const DEFAULT_PROMPT_CONTEXT = {
  view_kind_guidance: [
    'VIEW KIND GUIDANCE (for dynamic ref rendering):',
    '- Return a _view object whenever your output data is meant for a ref element.',
    '- Allowed _view.kind values only: table, editable-table, chart, metric, list, badge, text, narrative, markdown, form, filter, todo, alert.',
    '- If uncertain, use "table".',
  ].join('\n'),
  card_layout_guidance: [
    'CARD LAYOUT GUIDANCE:',
    '- Prefer compact outputs that fit a card.',
    '- Avoid repeating values already present in upstream inputs.',
  ].join('\n'),
};

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const extra = context?.extra || {};
  const executorDir = context?.executorDir || process.cwd();
  const promptContext = context?.promptContext || DEFAULT_PROMPT_CONTEXT;

  const cfg = typeof sourceDef.foundry === 'object' ? sourceDef.foundry : {};
  if (!cfg.prompt_template) {
    return { result: 'failure', data: { error: 'foundry: prompt_template is required' }, error: 'missing prompt_template' };
  }

  // Load defaults from server-config.json (endpoint + agent_id)
  let foundryDefaults = {};
  try {
    const serverConfig = readJson(path.join(executorDir, 'server-config.json'));
    foundryDefaults = serverConfig.foundry || {};
  } catch {}

  const endpoint = cfg.endpoint || foundryDefaults.endpoint;
  const agentId  = cfg.agent_id || foundryDefaults.agent_id;
  if (!endpoint || !agentId) {
    return {
      result: 'failure',
      data: { error: 'foundry: endpoint and agent_id must be set in source_def or server-config.json' },
      error: 'missing endpoint/agent_id',
    };
  }

  const interpolationContext = { ...promptContext, ...(sourceDef._projections || {}), ...(cfg.args || {}) };
  const prompt = interpolate(cfg.prompt_template, interpolationContext);

  // Sandbox: same dirs as copilot — cards, runtime, runtime-out.
  const allowedDirs = [];
  if (extra.boardSetupRoot) {
    if (extra.boardRuntimeDir) allowedDirs.push(path.resolve(extra.boardSetupRoot, extra.boardRuntimeDir));
    if (extra.runtimeStatusDir) allowedDirs.push(path.resolve(extra.boardSetupRoot, extra.runtimeStatusDir));
    if (extra.cardsDir) allowedDirs.push(path.resolve(extra.boardSetupRoot, extra.cardsDir));
  }

  const invokeReq = {
    endpoint,
    agent_id: agentId,
    prompt,
    result_shape: cfg.result_shape || undefined,
    allowed_dirs: allowedDirs.length > 0 ? allowedDirs : undefined,
  };

  const tmpBase = path.join(process.env.TEMP || process.cwd(), `foundry-handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const reqFile = `${tmpBase}.req.json`;
  const resFile = `${tmpBase}.res.json`;
  fs.writeFileSync(reqFile, JSON.stringify(invokeReq), 'utf-8');

  const python = process.platform === 'win32' ? 'python' : 'python3';
  const invokePath = path.join(executorDir, 'scripts', 'foundry', 'invoke.py');

  try {
    execFileSync(python, [invokePath, '--input', reqFile, '--output', resFile], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
      windowsHide: true,
    });
    const resultValue = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
    return { result: 'failure', data: { error: `foundry invocation failed: ${msg}` }, error: msg };
  } finally {
    try { fs.unlinkSync(reqFile); } catch {}
    try { fs.unlinkSync(resFile); } catch {}
  }
}
