#!/usr/bin/env node

/**
 * foundry-handler.js — Azure AI Foundry Agent invocation via Managed Identity.
 *
 * Runs entirely in-process using the shared Node Foundry client
 * (../../../lib/foundry-agents.js, backed by @azure/ai-agents + @azure/identity
 * DefaultAzureCredential). No Python, no API keys — MI in prod, `az login` locally.
 *
 * Endpoint + agent id come from `extra.foundryEndpoint` / `extra.foundryTaskExecutorAgentId`
 * (baked into executionExtra by the hosted runtime) or from the source_def itself.
 *
 * When `foundry.allowed_dirs` is provided, the agent gets sandboxed local file
 * tools (read_file, list_dir, patch_json_file, read_pdf).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createFoundryClient,
  functionTool,
  runAgentToolLoop,
} from '../../../lib/foundry-agents.js';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

// Prepend a runtime handles block so a source_def foundry run knows which board
// it belongs to. The chat path injects board_id into liveboards.* tool args
// automatically; source_def runs talk to MCP directly, so we surface the same
// board_id in the prompt and instruct the agent to pass it on every call.
function buildHandlesSection(extra) {
  const boardId = typeof extra?.boardId === 'string' ? extra.boardId.trim() : '';
  if (!boardId) return '';
  return [
    'RUNTIME HANDLES (provided by the board runtime — use these exact values):',
    `- board_id: "${boardId}"`,
    'This is the board you are running on. Whenever you call a liveboards.* tool that takes a board_id (or board) argument, pass this exact board_id so the tool reads and writes your own board rather than any default.',
    '',
    '',
  ].join('\n');
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

// ---------------------------------------------------------------------------
// Sandboxed local file tools (only enabled when allowed_dirs is non-empty).
// ---------------------------------------------------------------------------

function safeRealPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isPathAllowed(filepath, allowedDirs) {
  const real = safeRealPath(filepath);
  return allowedDirs.some((d) => {
    const realDir = safeRealPath(d);
    return real === realDir || real.startsWith(realDir + path.sep);
  });
}

function toolReadFile(args, allowedDirs) {
  const p = args?.path || '';
  if (!p) return JSON.stringify({ error: 'path is required' });
  if (!isPathAllowed(p, allowedDirs)) {
    return JSON.stringify({ error: 'access denied: path not in allowed directories' });
  }
  try {
    const content = fs.readFileSync(p, 'utf-8').slice(0, 512_000);
    return JSON.stringify({ path: p, content });
  } catch (e) {
    return JSON.stringify({ error: String(e?.message || e) });
  }
}

function toolListDir(args, allowedDirs) {
  const p = args?.path || '';
  if (!p) return JSON.stringify({ error: 'path is required' });
  if (!isPathAllowed(p, allowedDirs)) {
    return JSON.stringify({ error: 'access denied: path not in allowed directories' });
  }
  try {
    const entries = fs
      .readdirSync(p, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }));
    return JSON.stringify({ path: p, entries });
  } catch (e) {
    return JSON.stringify({ error: String(e?.message || e) });
  }
}

function setByJsonPath(root, jsonPath, value) {
  const segments = jsonPath.split(/\.|(?=\[)/).filter((s) => s.length > 0);
  let obj = root;
  for (const seg of segments.slice(0, -1)) {
    const m = /^\[(\d+)\]$/.exec(seg);
    obj = m ? obj[Number.parseInt(m[1], 10)] : obj[seg];
  }
  const last = segments[segments.length - 1];
  const m = /^\[(\d+)\]$/.exec(last);
  if (m) {
    obj[Number.parseInt(m[1], 10)] = value;
  } else {
    obj[last] = value;
  }
}

function findRepoRoot(startDir) {
  let current = startDir;
  for (;;) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'node_modules'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function validateCard(filepath) {
  const repoRoot = findRepoRoot(path.dirname(filepath)) || findRepoRoot(HANDLER_DIR);
  if (!repoRoot) return { ok: true, errors: [] };

  const cliJs = path.join(repoRoot, 'demo-board', 'scripts', 'cli', 'board-live-cards-cli.mjs');
  if (!fs.existsSync(cliJs)) return { ok: true, errors: [] };

  try {
    const cardJson = fs.readFileSync(filepath, 'utf-8');
    const stdout = execFileSync(process.execPath, [cliJs, 'validate-card-preflight'], {
      input: cardJson,
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: repoRoot,
      windowsHide: true,
    });
    if (!stdout.trim()) return { ok: true, errors: [] };

    const parsed = JSON.parse(stdout.trim());
    if (parsed.status === 'success') {
      const data = parsed.data || {};
      return { ok: data.isValid !== false, errors: data.issues || [] };
    }
    return { ok: false, errors: [parsed.error || 'validation failed'] };
  } catch {
    return { ok: true, errors: [] };
  }
}

function toolPatchJsonFile(args, allowedDirs) {
  const filepath = args?.path || '';
  const jsonPath = args?.json_path || '';
  const value = args?.value;
  if (!filepath || !jsonPath) {
    return JSON.stringify({ error: 'path and json_path are required' });
  }
  if (!isPathAllowed(filepath, allowedDirs)) {
    return JSON.stringify({ error: 'access denied: path not in allowed directories' });
  }

  let originalContent;
  let data;
  try {
    originalContent = fs.readFileSync(filepath, 'utf-8');
    data = JSON.parse(originalContent);
  } catch (e) {
    return JSON.stringify({ error: `cannot read file: ${e?.message || e}` });
  }

  try {
    setByJsonPath(data, jsonPath, value);
  } catch (e) {
    return JSON.stringify({ error: `invalid json_path '${jsonPath}': ${e?.message || e}` });
  }

  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    return JSON.stringify({ error: `cannot write file: ${e?.message || e}` });
  }

  const validation = validateCard(filepath);
  if (validation.ok === false) {
    try {
      fs.writeFileSync(filepath, originalContent, 'utf-8');
    } catch {
      // best effort revert
    }
    return JSON.stringify({
      error: 'patch reverted — card schema validation failed',
      validation_errors: validation.errors || [],
      hint: 'Fix the value to match the card schema and try again.',
    });
  }

  return JSON.stringify({ ok: true, path: filepath, json_path: jsonPath, validated: true });
}

async function toolReadPdf(args, allowedDirs) {
  const filepath = args?.path || '';
  const pages = Array.isArray(args?.pages) ? args.pages : null;
  if (!filepath) return JSON.stringify({ error: 'path is required' });
  if (!isPathAllowed(filepath, allowedDirs)) {
    return JSON.stringify({ error: 'access denied: path not in allowed directories' });
  }

  let PDFParse;
  try {
    ({ PDFParse } = await import('pdf-parse'));
  } catch {
    return JSON.stringify({ error: 'pdf-parse not installed. Run: npm install pdf-parse' });
  }

  let parser;
  try {
    const buffer = fs.readFileSync(filepath);
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();

    // result.pages: [{ num (1-based), text }]. Expose 0-based page numbers to
    // match the tool contract.
    const byZeroIndex = new Map();
    for (const pg of result.pages || []) {
      byZeroIndex.set((pg.num || 0) - 1, pg.text || '');
    }
    const totalPages = result.total || byZeroIndex.size;
    const indices = pages || Array.from(byZeroIndex.keys()).sort((a, b) => a - b);

    const resultPages = [];
    let totalChars = 0;
    for (const i of indices) {
      if (!byZeroIndex.has(i)) continue;
      const text = byZeroIndex.get(i);
      totalChars += text.length;
      resultPages.push({ page: i, text });
      if (totalChars > 200_000) {
        resultPages.push({
          page: 'truncated',
          text: `... output truncated at ${totalChars} chars. Use 'pages' parameter to read specific pages.`,
        });
        break;
      }
    }
    return JSON.stringify({ path: filepath, total_pages: totalPages, pages: resultPages });
  } catch (e) {
    return JSON.stringify({ error: String(e?.message || e) });
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // best effort
      }
    }
  }
}

function buildFileTools() {
  return [
    functionTool(
      'read_file',
      'Read the contents of a local file. Use this to examine card definitions, runtime data, or configuration files.',
      {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the file to read.' } },
        required: ['path'],
      },
    ),
    functionTool(
      'list_dir',
      'List the contents of a local directory. Returns file and directory names with their types.',
      {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the directory to list.' } },
        required: ['path'],
      },
    ),
    functionTool(
      'patch_json_file',
      'Update a specific value in a JSON file. Reads the file, sets the value at the given path, and writes back. Use for updating card_data, marking todos done, etc.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the JSON file to patch.' },
          json_path: {
            type: 'string',
            description: "Dot-separated path to the value to set. Use [N] for array indices. Example: 'card_data.items[2].done'",
          },
          value: { description: 'The new value to set (any JSON type: string, number, boolean, object, array, null).' },
        },
        required: ['path', 'json_path', 'value'],
      },
    ),
    functionTool(
      'read_pdf',
      'Extract text from a PDF file. Returns page-by-page text content. Use for reading compliance documents, reports, policies, or any PDF in the allowed directories.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the PDF file to read.' },
          pages: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional list of 0-based page numbers to read. If omitted, reads all pages.',
          },
        },
        required: ['path'],
      },
    ),
  ];
}

const TOOL_HANDLERS = {
  read_file: toolReadFile,
  list_dir: toolListDir,
  patch_json_file: toolPatchJsonFile,
  read_pdf: toolReadPdf,
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
  const agentId = cfg.agent_id || (typeof extra.foundryTaskExecutorAgentId === 'string' ? extra.foundryTaskExecutorAgentId.trim() : '');
  if (!endpoint || !agentId) {
    return {
      result: 'failure',
      data: { error: 'foundry: endpoint and agent_id must be set in source_def or via executionExtra (foundryEndpoint / foundryTaskExecutorAgentId)' },
      error: 'missing endpoint/agent_id',
    };
  }

  const interpolationContext = { ...promptContext, ...(sourceDef._projections || {}), ...(cfg.args || {}) };
  let prompt = interpolate(cfg.prompt_template, interpolationContext);

  const handles = buildHandlesSection(extra);
  if (handles) prompt = `${handles}${prompt}`;

  const resultShape = cfg.result_shape && typeof cfg.result_shape === 'object' ? cfg.result_shape : null;
  const allowedDirs = Array.isArray(cfg.allowed_dirs)
    ? cfg.allowed_dirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
    : [];

  if (allowedDirs.length) {
    const dirsDesc = allowedDirs.map((d) => `  - ${d}`).join('\n');
    prompt += `\n\nYou have access to local file tools (read_file, list_dir, patch_json_file, read_pdf) for browsing these directories:\n${dirsDesc}`;
  }
  if (resultShape) {
    prompt += `\n\nIMPORTANT: Return your answer as valid JSON with these top-level keys: ${Object.keys(resultShape).join(', ')}. No markdown fences, no extra text outside the JSON.`;
  }

  const tools = allowedDirs.length ? buildFileTools() : [];

  const configuredTimeoutMs = [cfg.timeout_ms, extra.taskExecutorTimeoutMs]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  const timeoutMs = configuredTimeoutMs ?? 2_100_000;

  let client;
  let threadId;
  try {
    client = createFoundryClient(endpoint);
    const thread = await client.threads.create();
    threadId = thread.id;

    const loop = await runAgentToolLoop({
      client,
      agentId,
      threadId,
      userPrompt: prompt,
      tools,
      timeoutMs,
      maxIters: 10,
      fetchFinalText: true,
      onToolCall: async (name, args) => {
        const handler = TOOL_HANDLERS[name];
        if (!handler) return JSON.stringify({ error: `unknown tool: ${name}` });
        return handler(args, allowedDirs);
      },
    });

    let resultValue = loop.finalText;
    try {
      resultValue = JSON.parse(loop.finalText);
    } catch {
      resultValue = loop.finalText;
    }

    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = err?.message || String(err);
    return { result: 'failure', data: { error: `foundry invocation failed: ${msg}` }, error: msg };
  } finally {
    if (client && threadId) {
      try {
        await client.threads.delete(threadId);
      } catch {
        // best effort cleanup
      }
    }
  }
}
