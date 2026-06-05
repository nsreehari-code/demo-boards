#!/usr/bin/env node

/**
 * foundry-handler.js — Azure AI Foundry Agent invocation via Managed Identity.
 *
 * Shells out to the local invoke.py helper (uses azure-identity + azure-ai-inference).
 * No API keys needed — uses DefaultAzureCredential (MI in prod, az login locally).
 *
 * Endpoint + agent id come from `extra.foundryEndpoint` / `extra.foundryTaskExecutorAgentId`
 * (baked into executionExtra by the hosted runtime) or from the source_def itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const FOUNDRY_INVOKE_SCRIPT = path.join(HANDLER_DIR, 'invoke.py');

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
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
  const promptContext = context?.promptContext || DEFAULT_PROMPT_CONTEXT;

  const cfg = typeof sourceDef.foundry === 'object' ? sourceDef.foundry : {};
  if (!cfg.prompt_template) {
    return { result: 'failure', data: { error: 'foundry: prompt_template is required' }, error: 'missing prompt_template' };
  }

  const endpoint = cfg.endpoint || (typeof extra.foundryEndpoint === 'string' ? extra.foundryEndpoint.trim() : '');
  const agentId  = cfg.agent_id || (typeof extra.foundryTaskExecutorAgentId === 'string' ? extra.foundryTaskExecutorAgentId.trim() : '');
  if (!endpoint || !agentId) {
    return {
      result: 'failure',
      data: { error: 'foundry: endpoint and agent_id must be set in source_def or via executionExtra (foundryEndpoint / foundryTaskExecutorAgentId)' },
      error: 'missing endpoint/agent_id',
    };
  }

  const interpolationContext = { ...promptContext, ...(sourceDef._projections || {}), ...(cfg.args || {}) };
  const prompt = interpolate(cfg.prompt_template, interpolationContext);

  const invokeReq = {
    endpoint,
    agent_id: agentId,
    prompt,
    result_shape: cfg.result_shape || undefined,
  };

  const tmpBase = path.join(process.env.TEMP || process.cwd(), `foundry-handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const reqFile = `${tmpBase}.req.json`;
  const resFile = `${tmpBase}.res.json`;
  fs.writeFileSync(reqFile, JSON.stringify(invokeReq), 'utf-8');

  const python = process.platform === 'win32' ? 'python' : 'python3';

  try {
    execFileSync(python, [FOUNDRY_INVOKE_SCRIPT, '--input', reqFile, '--output', resFile], {
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
