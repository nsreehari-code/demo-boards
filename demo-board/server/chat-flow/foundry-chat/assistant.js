#!/usr/bin/env node

/**
 * foundry-chat/assistant.js — Foundry-backed chat assistant.
 *
 * Same stdin contract as copilot-chat/assistant.js. Loads the shared
 * instructions/skills from chat-flow/ and delegates to invoke.py for the
 * Foundry agent tool-loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readChatMessagesViaMcp,
  readEnhancedChatMessages,
  readJsonStdin,
  requireRequiredStrings,
  resolveAssistantDebugEnabled,
  resolveAssistantDebugFile,
  resolveBoardLogsDir,
  resolveStreamableMcpServerUrl,
  readCardPrivateFieldViaApi,
  writeCardPrivateFieldViaApi,
} from '../copilot-chat/shared.js';
import {
  resolveAgentOutputFilePath,
  resolveAgentWatchpartyCardDir,
} from '../copilot-chat/watchparty.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FLOW_DIR = path.resolve(HERE, '..');
const INSTRUCTIONS_DIR = path.join(CHAT_FLOW_DIR, 'instructions');
const SKILLS_DIR = path.join(CHAT_FLOW_DIR, 'skills');
const INVOKE_PY = path.join(HERE, 'invoke.py');

const extra = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  logId = '',
  turnId = '',
  serverUrl = '',
  mcpServerUrl = '',
  aiWorkspaceRoot = '',
  boardSetupRoot = '',
  watchPartyFilesForChatDir = '',
  foundryEndpoint = '',
  foundryChatAgentId = '',
  foundryChatExposedMcpToolPrefixes = [],
  chatCopilotTimeoutMs: rawTimeoutMs = 300000,
} = extra;

const chatTimeoutMs = Number.isFinite(Number(rawTimeoutMs)) && Number(rawTimeoutMs) > 0
  ? Math.floor(Number(rawTimeoutMs))
  : 300000;

const DEBUG_FLAG = resolveAssistantDebugEnabled();
const DEBUG_FILE_OVERRIDE = resolveAssistantDebugFile();
const BOARD_LOGS_DIR = resolveBoardLogsDir(boardId);
const DEBUG_LOG_FILE = DEBUG_FILE_OVERRIDE
  || path.join(BOARD_LOGS_DIR, 'foundry-assistant-debug.jsonl');
const INVOKE_STDERR_LOG_FILE = path.join(BOARD_LOGS_DIR, 'foundry-invoke.stderr.log');
const LIFECYCLE_LOG_FILE = path.join(BOARD_LOGS_DIR, 'foundry-assistant.lifecycle.log');

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

function appendDebug(stage, details = {}) {
  if (!DEBUG_FLAG || !DEBUG_LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
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
      `boardId=${boardId || ''}`,
      `cardId=${cardId || ''}`,
      `turnId=${turnId || ''}`,
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

function persistLifecycleLog(stage, details = {}) {
  try {
    fs.mkdirSync(path.dirname(LIFECYCLE_LOG_FILE), { recursive: true });
    const lines = [
      `ts=${new Date().toISOString()}`,
      `pid=${process.pid}`,
      `stage=${stage}`,
      `boardId=${boardId || ''}`,
      `cardId=${cardId || ''}`,
      `turnId=${turnId || ''}`,
    ];
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || value === null || value === '') continue;
      lines.push(`${key}=${String(value)}`);
    }
    fs.appendFileSync(LIFECYCLE_LOG_FILE, `${lines.join('\n')}\n\n`, 'utf-8');
  } catch {}
}

process.on('uncaughtException', (err) => {
  persistInvokeFailureLog('uncaught-exception', {
    message: err?.stack || err?.message || String(err),
  });
  throw err;
});

process.on('unhandledRejection', (reason) => {
  persistInvokeFailureLog('unhandled-rejection', {
    message: reason?.stack || reason?.message || String(reason),
  });
});

function resolveBoardServerPort(explicitServerUrl) {
  try {
    const parsedUrl = new URL(String(explicitServerUrl || '').trim());
    const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('serverUrl port is not a positive number');
    }
    return port;
  } catch (err) {
    throw new Error(`Cannot resolve board server port from serverUrl: ${err?.message || err}`);
  }
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

  // Skills live as <SKILLS_DIR>/<name>/SKILL.md (plus optional siblings).
  if (fs.existsSync(SKILLS_DIR)) {
    const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of skillDirs) {
      const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const text = fs.readFileSync(skillFile, 'utf-8').trim();
          if (text) sections.push(`### Skill: ${name}\n${text}`);
        } catch {}
      }
    }
    // Also pick up any top-level markdown notes alongside skills (e.g. live-board-cards-soul.md).
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
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

async function loadPromptChatMessages() {
  const turnScoped = await readEnhancedChatMessages(boardId, cardId, 30000, {
    turnId,
    logId,
    mcpServerUrl,
  });
  if (Array.isArray(turnScoped) && turnScoped.length > 0) return turnScoped;
  return readChatMessagesViaMcp(boardId, cardId, {
    logId,
    turnId,
    mcpServerUrl,
  });
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
  boardId,
  cardId,
  logId,
  turnId,
  serverUrl,
  mcpServerUrl,
  foundryEndpoint,
  foundryChatAgentId,
}, 'foundry-chat assistant');

persistLifecycleLog('start', {
  foundryEndpoint,
  foundryChatAgentId,
  mcpServerUrl,
  serverUrl,
});

appendDebug('foundry-assistant:start', {
  boardId, cardId, turnId, foundryEndpoint, foundryChatAgentId, chatTimeoutMs,
});

const outputFile = watchPartyFilesForChatDir ? resolveAgentOutputFilePath(watchPartyFilesForChatDir, cardId) : '';
const cardWatchDir = watchPartyFilesForChatDir ? resolveAgentWatchpartyCardDir(watchPartyFilesForChatDir, cardId) : '';

function cleanupWatchpartyFiles() {
  if (cardWatchDir) {
    try { fs.rmSync(cardWatchDir, { recursive: true, force: true }); } catch {}
    return;
  }
  if (outputFile) {
    try { fs.unlinkSync(outputFile); } catch {}
  }
}

cleanupWatchpartyFiles();
if (outputFile) {
  try {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, 'Reasoning...\n', 'utf-8');
  } catch {}
}

const FOUNDRY_THREAD_PRIVATE_KEY = 'chat.foundry_thread_id';
const boardServerPort = resolveBoardServerPort(serverUrl);
const existingThreadId = await (async () => {
  try {
    const value = await readCardPrivateFieldViaApi({
      boardServerPort,
      boardId,
      cardId,
      fieldName: FOUNDRY_THREAD_PRIVATE_KEY,
    });
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  } catch { return ''; }
})();
persistLifecycleLog('thread-id-loaded', {
  existingThreadId: existingThreadId || '(empty)',
});
const normalizedMcpServerUrl = resolveStreamableMcpServerUrl(mcpServerUrl).trim();

const promptChatMessages = await loadPromptChatMessages();
persistLifecycleLog('prompt-chat-loaded', {
  promptChatMessagesCount: Array.isArray(promptChatMessages) ? promptChatMessages.length : 0,
});
const transcript = formatChatTranscript(promptChatMessages);
const skillsBlock = loadInstructionsAndSkills();
const systemInstructions = buildSystemInstructions(skillsBlock);

const userPrompt = ['## Current turn transcript', '', transcript].join('\n');

appendDebug('foundry-assistant:promptBuilt', {
  transcriptLength: transcript.length,
  skillsBlockLength: skillsBlock.length,
  systemInstructionsLength: systemInstructions.length,
});
persistLifecycleLog('prompt-built', {
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
  exposed_mcp_tool_prefixes: Array.isArray(foundryChatExposedMcpToolPrefixes)
    ? foundryChatExposedMcpToolPrefixes
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => entry.trim())
    : [],
  existing_thread_id: existingThreadId,
  output_file: outputFile,
  timeout_seconds: Math.floor(chatTimeoutMs / 1000),
};

const python = resolvePythonExecutable();
appendDebug('foundry-assistant:pythonResolved', { python });
persistLifecycleLog('invoke-ready', {
  python,
  outputFile: outputFile || '(none)',
});

await new Promise((resolve, reject) => {
  persistLifecycleLog('spawning-invoke', { python });
  const child = spawn(python, [INVOKE_PY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  });
  let stderrBuf = '';
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    // invoke.py streams progress as JSONL on stdout; mirror to output file so watchparty sees it.
    if (outputFile) {
      try { fs.appendFileSync(outputFile, chunk); } catch {}
    }
    stdoutBuf += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });
  const timeoutId = setTimeout(() => {
    try { child.kill(); } catch {}
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
    if (code === 0) {
      (async () => {
        try {
          let resolvedThreadId = '';
          for (const line of stdoutBuf.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const obj = JSON.parse(trimmed);
              if (obj && obj.stage === 'thread-resolved' && typeof obj.thread_id === 'string') {
                resolvedThreadId = obj.thread_id.trim();
              }
              continue;
            } catch {}
            const match = /^thread-resolved:\s+thread_id=([^;\s]+)\b/i.exec(trimmed);
            if (match && typeof match[1] === 'string') {
              resolvedThreadId = match[1].trim();
            }
          }
          if (resolvedThreadId && resolvedThreadId !== existingThreadId) {
            await writeCardPrivateFieldViaApi({
              boardServerPort,
              boardId,
              cardId,
              fieldName: FOUNDRY_THREAD_PRIVATE_KEY,
              value: resolvedThreadId,
            });
          }
        } catch {}
        resolve();
      })();
      return;
    }
    persistInvokeFailureLog('nonzero-exit', {
      message: `invoke.py exited with code ${code}`,
      stderr: stderrBuf,
      stdout: stdoutBuf,
    });
    appendDebug('foundry-assistant:invokeFailed', {
      code,
      stderr: stderrBuf,
      stdoutTail: stdoutBuf.slice(-2000),
      invokeStderrLogFile: INVOKE_STDERR_LOG_FILE,
    });
    reject(new Error(stderrBuf.trim() || `invoke.py exited with code ${code}`));
  });
  child.stdin.end(JSON.stringify(invokeRequest));
});

appendDebug('foundry-assistant:success', { turnId });
process.stdout.write(JSON.stringify({ assistantHandled: true }));
