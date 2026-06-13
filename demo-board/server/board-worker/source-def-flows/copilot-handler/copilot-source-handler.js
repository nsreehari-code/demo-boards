#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCopilot as spawnCopilot } from '../../../lib/copilot-cli.js';
import { createWatchpartyEmitter } from '../../../shared/watchparty-notify.js';
import { resolveCopilotWorkspaceDirByStem, deriveLogIdFromCardId } from '../../../chat-flow/shared.js';

// ---------------------------------------------------------------------------
// Output processing — copilot decorates its output with tool-op and stats lines
// that must be stripped before we can parse the model's actual JSON answer.
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^[\u25cf\u2022] /,                 // ● bullet tool ops
  /^X /,                             // X failed tool ops
  /^\$ /,                            // $ shell commands
  /^[\u2514\u251c]/,                 // └ ├ tree lines
  /session-state.*\.json/,          // session-state file paths
  /agent.decision has been simulated/,
  /has been simulated and saved/,
  /^\d+ (?:files?|lines?|matches?) found$/,
  /^No matches found$/,
  /^Path does not exist$/,
  /^\d+ lines?(?: read)?$/,
];

const STATS_PREFIXES = [
  'Total usage est:', 'API time spent:', 'Total session time:',
  'Total code changes:', 'Breakdown by AI model:', 'Session:',
  'Changes', 'Requests', 'Tokens',
];

const KNOWN_NOISE_LINES = [
  "error: unknown option '--no-warnings'",
  "Try 'copilot --help' for more information",
];

function cleanOutput(raw) {
  const lines = String(raw).split(/\r?\n/).filter(
    (line) => !KNOWN_NOISE_LINES.some((noise) => line.includes(noise)),
  );
  const contentLines = lines.filter((line) => {
    const stripped = line.replace(/^\s+/, '');
    return !NOISE_PATTERNS.some((p) => p.test(stripped));
  });
  const resultLines = [];
  let hitStats = false;
  for (const line of contentLines) {
    if (!hitStats) {
      const stripped = line.replace(/^\s+/, '');
      if (STATS_PREFIXES.some((prefix) => stripped.startsWith(prefix))) hitStats = true;
    }
    if (!hitStats) resultLines.push(line);
  }
  return resultLines.join('\n').trim();
}

function extractJson(text, shapeKeys) {
  const hasShape = (obj) => !shapeKeys || shapeKeys.length === 0
    || shapeKeys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));

  const fenced = /```json\s*([\s\S]*?)```/.exec(text);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1].trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && hasShape(obj)) return fenced[1].trim();
    } catch {}
  }

  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate);
          if (obj && typeof obj === 'object' && !Array.isArray(obj) && hasShape(obj)) return candidate;
        } catch {}
        start = -1;
      }
    }
  }
  return null;
}

function shapeSkeleton(shapeKeys) {
  if (shapeKeys && shapeKeys.length > 0) {
    return JSON.stringify(Object.fromEntries(shapeKeys.map((k) => [k, null])));
  }
  return '{}';
}

// Persist a stable session id per agent so copilot's native --session-id can
// resume multi-turn context across runs.
function getOrCreateSessionId(aiWorkspaceRoot, bindTo) {
  const sessionDir = path.join(
    aiWorkspaceRoot,
    'copilot-sessions',
    String(bindTo || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  const idFile = path.join(sessionDir, 'session.id');
  if (fs.existsSync(idFile)) return fs.readFileSync(idFile, 'utf-8').trim();
  const id = randomUUID();
  fs.writeFileSync(idFile, id, 'utf-8');
  return id;
}

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
    '- For array rows that users should edit, prefer "editable-table" and set _view.data.writeTo to a card_data path.',
    '- For chart, set _view.data.chartType and _view.data.columns with [labelField, valueField].',
    '- Keep _view.data minimal and valid JSON (no comments, no trailing text).',
  ].join('\n'),
  card_layout_guidance: [
    'CARD LAYOUT GUIDANCE:',
    '- Prefer compact outputs that fit a card: one primary structure plus concise rationale text.',
    '- Avoid repeating values already present in upstream inputs.',
    '- If you produce both machine-readable and human-readable content, keep machine-readable fields top-level and concise prose in a separate field.',
  ].join('\n'),
};

function resolvePrompt(sourceDef, promptContext) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  if (!template || typeof template !== 'string') return null;
  const args = {
    ...(promptContext || DEFAULT_PROMPT_CONTEXT),
    ...(sourceDef?._projections || {}),
    ...(cfg.args || sourceDef.args || {}),
  };
  return interpolate(template, args);
}

// Prepend a runtime handles block so a source_def copilot run knows which board
// it belongs to. The chat path injects board_id + log_id into liveboards.* tool
// args automatically; source_def runs talk to MCP directly, so we surface the
// same handles in the prompt and instruct the agent to pass them on every call.
// Passing log_id is what keys the agent-tools watch-party stream back to this
// card (the controlface surface only emits the tools stream when log_id is set).
function buildHandlesSection(extra) {
  const boardId = typeof extra?.boardId === 'string' ? extra.boardId.trim() : '';
  if (!boardId) return '';
  const cardId = typeof extra?.cardId === 'string' ? extra.cardId.trim() : '';
  const logId = cardId ? deriveLogIdFromCardId(cardId) : '';
  const lines = [
    'RUNTIME HANDLES (provided by the board runtime — use these exact values):',
    `- board_id: "${boardId}"`,
  ];
  if (logId) lines.push(`- log_id: "${logId}"`);
  lines.push('This is the board you are running on. Whenever you call a liveboards.* tool that takes a board_id (or board) argument, pass this exact board_id so the tool reads and writes your own board rather than any default.');
  if (logId) lines.push('Also pass this exact log_id on every liveboards.* tool call so your tool activity streams to your own card\'s watch-party.');
  lines.push('', '');
  return lines.join('\n');
}

async function runCopilot(prompt, sourceDef, executorDir, extra) {
  const copilotCwd = extra?.aiWorkspaceRoot || process.cwd();
  const bindTo = String(sourceDef?.bindTo || 'executor');
  const sessionId = getOrCreateSessionId(copilotCwd, bindTo);

  const shape = sourceDef?.copilot?.result_shape ?? sourceDef?.result_shape;
  const shapeKeys = shape && typeof shape === 'object' && !Array.isArray(shape)
    ? Object.keys(shape)
    : null;

  const invoke = async (text) => {
    const { stdout, stderr } = await spawnCopilot({
      prompt: text,
      workingDir: copilotCwd,
      sessionId,
    });
    return cleanOutput(stderr ? `${stdout}\n${stderr}` : stdout);
  };

  // First attempt
  const cleaned = await invoke(prompt);
  let found = cleaned ? extractJson(cleaned, shapeKeys) : null;

  // One retry asking copilot for JSON only (resumes the same native session)
  if (!found && cleaned) {
    const retryPrompt = [
      'Your previous response did not contain a valid JSON object.',
      'Please respond with ONLY the JSON object — no markdown, no explanation, no preamble.',
      'Start your response with { and end with }.',
    ].join('\n');
    found = extractJson(await invoke(retryPrompt), shapeKeys);
  }

  const jsonText = found || shapeSkeleton(shapeKeys);
  return JSON.parse(jsonText);
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const extra = context?.extra || {};
  const executorDir = context?.executorDir || process.cwd();
  const promptContext = context?.promptContext || DEFAULT_PROMPT_CONTEXT;

  const prompt = resolvePrompt(sourceDef, promptContext);
  if (!prompt) {
    return {
      result: 'failure',
      data: { error: 'Source definition missing copilot.prompt_template (or prompt_template)' },
      error: 'missing prompt_template',
    };
  }

  try {
    const handles = buildHandlesSection(extra);
    const finalPrompt = handles ? `${handles}${prompt}` : prompt;
    const resultValue = await runCopilot(finalPrompt, sourceDef, executorDir, extra);
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = String(err?.message || err);
    return { result: 'failure', data: { error: `copilot invocation failed: ${msg}` }, error: msg };
  }
}
