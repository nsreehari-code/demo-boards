/**
 * foundry-chat/assistant.js — Foundry-backed chat assistant.
 *
 * Exports `invokeAssistant(extra)`. Loads the shared instructions/skills
 * from chat-flow/ and delegates to invoke.py for the Foundry agent tool-loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENT_OUTPUT_FILE_STEM,
  getEnhancedChatMessages,
  requireRequiredStrings,
  resolveBoardLogPath,
  getCardPrivate,
  setCardPrivate,
} from '../shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FLOW_DIR = path.resolve(HERE, '..');
const INSTRUCTIONS_DIR = path.join(CHAT_FLOW_DIR, 'instructions');
const SKILLS_DIR = path.join(CHAT_FLOW_DIR, 'skills');
const INVOKE_PY = path.join(HERE, 'invoke.py');

function resolvePythonExecutable() {
  const explicit = typeof process.env.PYTHON_EXECUTABLE === 'string'
    ? process.env.PYTHON_EXECUTABLE.trim()
    : '';
  if (explicit) {
    return explicit;
  }

  const virtualEnv = typeof process.env.VIRTUAL_ENV === 'string'
    ? process.env.VIRTUAL_ENV.trim()
    : '';
  if (virtualEnv) {
    const candidates = process.platform === 'win32'
      ? [path.join(virtualEnv, 'Scripts', 'python.exe')]
      : [path.join(virtualEnv, 'bin', 'python3'), path.join(virtualEnv, 'bin', 'python')];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function readDirFilesRecursive(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readDirFilesRecursive(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function loadInstructionsAndSkills() {
  const sections = [];

  const instructionFiles = readDirFilesRecursive(INSTRUCTIONS_DIR, (f) => f.toLowerCase().endsWith('.md'))
    .sort();
  for (const file of instructionFiles) {
    try {
      const text = fs.readFileSync(file, 'utf-8').trim();
      if (text) sections.push(`### Instruction: ${path.basename(file)}\n${text}`);
    } catch {}
  }

  if (fs.existsSync(SKILLS_DIR)) {
    const skillEntries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = skillEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const name of skillDirs) {
      const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const text = fs.readFileSync(skillFile, 'utf-8').trim();
          if (text) sections.push(`### Skill: ${name}\n${text}`);
        } catch {}
      }
    }
    for (const entry of skillEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const file = path.join(SKILLS_DIR, entry.name);
        try {
          const text = fs.readFileSync(file, 'utf-8').trim();
          if (text) sections.push(`### Reference: ${entry.name}\n${text}`);
        } catch {}
      }
    }
  }

  return sections.join('\n\n---\n\n');
}

function extractVisibleMessageText(role, text) {
  if (typeof text !== 'string') return '(no text)';
  const trimmed = text.trim();
  if (!trimmed) return '(no text)';
  if (role === 'user') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
        return parsed.prompt.trim();
      }
    } catch {}
  }
  return trimmed;
}

function parseSystemMessageFileRef(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) return null;
  const match = /^(file uploaded|AI generated|AI geneterated):\s*(\S+?)(?:\s+as\s+\S+)?\s*#(\d+)\s*$/i
    .exec(messageText.trim());
  if (!match) return null;
  const kindRaw = match[1].toLowerCase();
  const kind = kindRaw.startsWith('file') ? 'user-uploaded' : 'ai-generated';
  const fileName = match[2];
  const fileIndex = Number.parseInt(match[3], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return null;
  return { kind, fileName, fileIndex };
}

function formatAttachmentRefLine(ref) {
  const label = ref.kind === 'ai-generated' ? 'AI-generated attachment' : 'uploaded attachment';
  return `[${label} name: ${ref.fileName}. file-index: ${ref.fileIndex}]`;
}

function formatChatTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'No current turn chat messages.';
  const blocks = [];
  let pendingRefs = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'system' && role !== 'user') continue;
    const text = extractVisibleMessageText(role, message.text);
    if (role === 'system') {
      const ref = parseSystemMessageFileRef(text);
      if (ref) { pendingRefs.push(ref); continue; }
      blocks.push(`System:\n${text}`);
      continue;
    }
    const lines = ["User's Question/Request:"];
    for (const ref of pendingRefs) lines.push(formatAttachmentRefLine(ref));
    pendingRefs = [];
    lines.push(text);
    blocks.push(lines.join('\n'));
  }
  if (pendingRefs.length > 0) {
    const lines = ['Attachments on this card (no user message yet):'];
    for (const ref of pendingRefs) lines.push(formatAttachmentRefLine(ref));
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export async function invokeAssistant(context, config = {}) {
  const {
    boardId,
    cardId,
    logId,
    turnId,
    serverUrl,
    mcpServerUrl,
    watchPartyDir,
  } = context;
  const {
    streamableMcpServerUrl = '',
    foundryEndpoint = '',
    foundryChatAgentId = '',
    foundryChatExposedMcpToolPrefixes = [],
    chatCopilotTimeoutMs: rawTimeoutMs = 300000,
    enableAssistantDebug = false,
  } = config;

  const chatTimeoutMs = Number.isFinite(Number(rawTimeoutMs)) && Number(rawTimeoutMs) > 0
    ? Math.floor(Number(rawTimeoutMs))
    : 300000;

  const DEBUG_LOG_FILE = resolveBoardLogPath(context, 'foundry-assistant-debug.jsonl');
  const INVOKE_STDERR_LOG_FILE = resolveBoardLogPath(context, 'foundry-invoke.stderr.log');
  if (enableAssistantDebug) {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
  }

  function appendDebug(stage, details = {}) {
    if (!enableAssistantDebug) return;
    try {
      fs.appendFileSync(
        DEBUG_LOG_FILE,
        JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, stage, ...details }) + '\n',
        'utf-8',
      );
    } catch {}
  }

  function persistInvokeFailureLog(kind, details = {}) {
    try {
      fs.mkdirSync(path.dirname(INVOKE_STDERR_LOG_FILE), { recursive: true });
      const lines = [
        `ts=${new Date().toISOString()}`,
        `pid=${process.pid}`,
        `kind=${kind}`,
        `boardId=${boardId}`,
        `cardId=${cardId}`,
        `turnId=${turnId}`,
      ];
      if (details.message) lines.push(`message=${String(details.message)}`);
      if (details.stderr) {
        lines.push('stderr<<EOF');
        lines.push(String(details.stderr));
        lines.push('EOF');
      }
      if (details.stdout) {
        lines.push('stdout<<EOF');
        lines.push(String(details.stdout));
        lines.push('EOF');
      }
      fs.appendFileSync(INVOKE_STDERR_LOG_FILE, `${lines.join('\n')}\n\n`, 'utf-8');
    } catch {}
  }

  function buildSystemInstructions(skillsBlock) {
    const head = [
      'You are responding for one live board chat turn.',
      'Use the available MCP tools (liveboards.* for board/card/chat state, lore.* for durable cross-board memory) to discover what you need; prefer the smallest tool call that resolves this turn.',
      'Treat the runtime handles below as authoritative. Every liveboards.* MCP tool call must use snake_case args and must include the provided opaque log_id exactly as given. Do not derive, alter, or omit it.',
      'Stay grounded in the current turn context — the user message, any current-turn system messages (including attachment references), and the contents of files those attachments point to. Reach into prior chat history only when the user intent clearly requires it.',
      'When the final user-visible reply is ready, call the liveboards.stage-ai-response-and-any-attachments tool exactly once with the final reply text. Do not include markdown fences. No fluff.',
      'Do not expose internal orchestration details, logs, refs, paths, directory names, or implementation notes.',
    ].join(' ');

    const handles = [
      'Runtime handles:',
      `- boardId: "${boardId || '(not provided)'}"`,
      `- cardId / card_id: "${cardId}"`,
      `- logId / log_id: "${logId || '(not provided)'}"`,
      `- turnId / turn_id: "${turnId}"`,
    ].join('\n');

    return [head, '', handles, '', '## Instructions and skills', '', skillsBlock].join('\n');
  }

  requireRequiredStrings({
    foundryEndpoint,
    foundryChatAgentId,
  }, 'foundry-chat assistant');

  appendDebug('foundry-assistant:start', {
    boardId, cardId, turnId, foundryEndpoint, foundryChatAgentId, chatTimeoutMs,
  });

  const outputFile = path.join(watchPartyDir, AGENT_OUTPUT_FILE_STEM);
  fs.writeFileSync(outputFile, 'Reasoning...\n', 'utf-8');

  const existingFoundryPrivate = await getCardPrivate(context, 'foundry');
  const existingThreadId = String(existingFoundryPrivate?.thread_id || '').trim();
  const normalizedMcpServerUrl = streamableMcpServerUrl.trim() || mcpServerUrl;

  const promptChatMessages = await getEnhancedChatMessages(context);
  const transcript = formatChatTranscript(promptChatMessages);
  const skillsBlock = loadInstructionsAndSkills();
  const systemInstructions = buildSystemInstructions(skillsBlock);

  const userPrompt = ['## Current turn transcript', '', transcript].join('\n');

  appendDebug('foundry-assistant:promptBuilt', {
    transcriptLength: transcript.length,
    skillsBlockLength: skillsBlock.length,
    systemInstructionsLength: systemInstructions.length,
  });

  const invokeRequest = {
    endpoint: foundryEndpoint,
    agent_id: foundryChatAgentId,
    system_instructions: systemInstructions,
    user_prompt: userPrompt,
    card_id: cardId,
    board_id: boardId,
    log_id: logId,
    turn_id: turnId,
    mcp_server_url: normalizedMcpServerUrl,
    exposed_mcp_tool_prefixes: foundryChatExposedMcpToolPrefixes
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => entry.trim()),
    existing_thread_id: existingThreadId,
    output_file: outputFile,
    timeout_seconds: Math.floor(chatTimeoutMs / 1000),
  };

  const python = resolvePythonExecutable();
  appendDebug('foundry-assistant:pythonResolved', { python });

  await new Promise((resolve, reject) => {
    const child = spawn(python, [INVOKE_PY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stderrBuf = '';
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      try { fs.appendFileSync(outputFile, chunk); } catch {}
      stdoutBuf += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    const timeoutId = setTimeout(() => {
      child.kill();
      persistInvokeFailureLog('timeout', {
        message: `foundry-chat invoke.py timed out after ${chatTimeoutMs}ms`,
        stderr: stderrBuf,
        stdout: stdoutBuf,
      });
      reject(new Error(`foundry-chat invoke.py timed out after ${chatTimeoutMs}ms`));
    }, chatTimeoutMs);
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      persistInvokeFailureLog('spawn-error', {
        message: err?.stack || err?.message || String(err),
        stderr: stderrBuf,
        stdout: stdoutBuf,
      });
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        persistInvokeFailureLog('nonzero-exit', {
          message: `invoke.py exited with code ${code}`,
          stderr: stderrBuf,
          stdout: stdoutBuf,
        });
        appendDebug('foundry-assistant:invokeFailed', {
          code,
          stderr: stderrBuf,
          stdoutTail: stdoutBuf.slice(-2000),
        });
        reject(new Error(stderrBuf.trim() || `invoke.py exited with code ${code}`));
        return;
      }
      const match = /\bthread-resolved:\s+thread_id=([^;\s]+)/i.exec(stdoutBuf);
      const resolvedThreadId = match ? match[1].trim() : '';
      if (resolvedThreadId && resolvedThreadId !== existingThreadId) {
        setCardPrivate(context, 'foundry', { thread_id: resolvedThreadId })
          .then(resolve, resolve);
        return;
      }
      resolve();
    });
    child.stdin.end(JSON.stringify(invokeRequest));
  });

  appendDebug('foundry-assistant:success', { turnId });
  return { assistantHandled: true };
}
