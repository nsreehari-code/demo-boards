#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  readChatMessagesViaMcp,
  readEnhancedChatMessages,
  readCardPrivateFieldViaMcpControlplane,
  readJsonStdin,
  requireRequiredStrings,
  resolveAssistantDebugEnabled,
  resolveAssistantDebugFile,
  resolveBoardLogsDir,
  stageAssistantReplyViaMcp,
} from './shared.js';
import {
  resolveAgentOutputFilePath,
  resolveAgentWatchpartyCardDir,
} from './watchparty.js';

const COPILOT_MODEL = 'gpt-5.4';

const extra = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  logId = '',
  turnId = '',
  aiWorkspaceRoot = '',
  boardSetupRoot = '',
  mcpServerUrl = '',
  watchPartyFilesForChatDir = '',
  copilotCustomWorkspaceStems = [],
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;
const bypassCopilotForTest = process.env.DEMO_T3A_BYPASS === '1';
const ENABLE_DEBUG_LOGGING = typeof process.env.ENABLE_DEBUG_LOGGING === 'string' ? process.env.ENABLE_DEBUG_LOGGING.trim() : '';

const DEBUG_FLAG = resolveAssistantDebugEnabled();
const DEBUG_FILE_OVERRIDE = resolveAssistantDebugFile();
const BOARD_LOGS_DIR = resolveBoardLogsDir(boardId);
const DEBUG_LOG_PATH = DEBUG_FILE_OVERRIDE || path.join(BOARD_LOGS_DIR, 'copilot-assistant-debug.log');
const DEBUG_LOG_FILE = DEBUG_FILE_OVERRIDE
  || path.join(BOARD_LOGS_DIR, 'assistant-debug.jsonl');
const agentOutputFile = watchPartyFilesForChatDir ? resolveAgentOutputFilePath(watchPartyFilesForChatDir, cardId) : '';
const agentWatchpartyCardDir = watchPartyFilesForChatDir ? resolveAgentWatchpartyCardDir(watchPartyFilesForChatDir, cardId) : '';

function normalizeWorkspaceStem(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveCopilotWorkspaceDirByStem(aiWorkspaceRootPath, workspaceStem, contextLabel = 'assistant') {
  requireRequiredStrings({ aiWorkspaceRoot: aiWorkspaceRootPath, workspaceStem }, contextLabel);
  if (!fs.existsSync(aiWorkspaceRootPath)) {
    throw new Error(`Missing required ${contextLabel} input: aiWorkspaceRoot directory`);
  }
  const workingDir = path.join(aiWorkspaceRootPath, workspaceStem);
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Missing required ${contextLabel} input: copilot workspace ${workspaceStem}`);
  }
  return workingDir;
}

async function resolveWorkspaceStem() {
  const configuredStems = Array.isArray(copilotCustomWorkspaceStems)
    ? copilotCustomWorkspaceStems.map((value) => normalizeWorkspaceStem(value)).filter(Boolean)
    : [];
  const knownStems = new Set(['default', ...configuredStems]);
  const privateStem = normalizeWorkspaceStem(await readCardPrivateFieldViaMcpControlplane({
    mcpServerUrl,
    boardId,
    cardId,
    fieldName: 'copilot-ws',
  }));
  if (privateStem && knownStems.has(privateStem)) {
    return privateStem;
  }
  return 'default';
}

function DBG_LOG(stage, details = {}) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      DEBUG_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        stage,
        bypassCopilotForTest,
        ...details,
      }) + '\n',
      'utf-8'
    );
  } catch {}
}

function appendDebug(stage, details = {}) {
  if (!DEBUG_FLAG || !DEBUG_LOG_FILE) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
    fs.appendFileSync(
      DEBUG_LOG_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        stage,
        ...details,
      }) + '\n',
      'utf-8'
    );
  } catch {}
}

function buildPrompt(cId, currentLogId, turnTranscript) {
  const instructionsBlock = [
    'You are responding for one live board chat turn.',
    'Use the available agent instructions, skills, and MCP tools to discover what you need. Prefer the smallest additional read or tool call that resolves the current turn.',
    'Treat the runtime handles below as authoritative. Every liveboards.* MCP tool call must use snake_case args and must include the provided opaque log_id exactly as given. Do not derive, alter, or omit it.',
    'Stay grounded in the current turn context — the current-turn user message, any current-turn system messages (including attachments referenced by them), and the contents of files those attachments point to. Read referenced attachment contents before reasoning. Reach into nearby board state or prior chat history only when the user intent clearly requires it; never use prior chat history to guess the current turn\u2019s answer.',
    'When the final user-visible reply is ready, use the provide-final-reply-to-user skill exactly once.',
    'Do not expose internal orchestration details, logs, refs, paths, directory names, or implementation notes.',
    'Do not include markdown fences. No fluff.',
  ].join(' ');

  const runtimeHandlesBlock = [
    'Runtime handles:',
    `- boardId: \"${boardId || '(not provided)'}\"`,
    `- cardId / card_id: "${cId}"`,
    `- logId / log_id: "${currentLogId || '(not provided)'}"`,
    `- turnId / turn_id: "${turnId}"`,
  ].join('\n');

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
    '',
    turnTranscript,
  ].join('\n');
}

function parseSystemMessageFileRef(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*(\S+?)(?:\s+as\s+\S+)?\s*#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) {
    return null;
  }

  const kindRaw = match[1].toLowerCase();
  const kind = kindRaw.startsWith('file') ? 'user-uploaded' : 'ai-generated';
  const fileName = match[2];
  const fileIndex = Number.parseInt(match[3], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return null;
  }

  return { kind, fileName, fileIndex };
}

function parseSystemMessageFileIndex(messageText) {
  const ref = parseSystemMessageFileRef(messageText);
  return ref ? ref.fileIndex : null;
}

function extractVisibleMessageText(role, text) {
  if (typeof text !== 'string') {
    return '(no text)';
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return '(no text)';
  }

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

function formatTranscriptMessage(message, currentCardId) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const role = typeof message.role === 'string' && message.role.trim()
    ? message.role.trim().toLowerCase()
    : 'message';
  const roleLabel = role === 'system'
    ? 'System'
    : role === 'user'
      ? 'User'
      : role === 'assistant'
        ? 'Assistant'
        : 'Message';
  const text = extractVisibleMessageText(role, message.text);
  const lines = [`${roleLabel}:`, text];

  const retrievalHint = typeof message?.retrieval_hint === 'string' && message.retrieval_hint.trim()
    ? message.retrieval_hint.trim()
    : typeof message?.payload?.retrieval_hint === 'string' && message.payload.retrieval_hint.trim()
      ? message.payload.retrieval_hint.trim()
      : '';
  if (retrievalHint) {
    lines.push(retrievalHint);
  }

  return lines.join('\n');
}

function formatAttachmentRefLine(ref) {
  const label = ref.kind === 'ai-generated' ? 'AI-generated attachment' : 'uploaded attachment';
  return `[${label} name: ${ref.fileName}. file-index: ${ref.fileIndex}]`;
}

function formatChatTranscript(messages, currentCardId) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'No current turn chat messages.';
  }

  const blocks = [];
  let pendingAttachmentRefs = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'system' && role !== 'user') continue;
    const text = extractVisibleMessageText(role, message.text);

    if (role === 'system') {
      const ref = parseSystemMessageFileRef(text);
      if (ref) {
        pendingAttachmentRefs.push(ref);
        continue;
      }
      const rendered = formatTranscriptMessage(message, currentCardId);
      if (rendered) blocks.push(rendered);
      continue;
    }

    const lines = ["User's Question/Request:"];
    for (const ref of pendingAttachmentRefs) {
      lines.push(formatAttachmentRefLine(ref));
    }
    pendingAttachmentRefs = [];
    lines.push(text);
    blocks.push(lines.join('\n'));
  }

  if (pendingAttachmentRefs.length > 0) {
    const lines = ['Attachments on this card (no user message yet):'];
    for (const ref of pendingAttachmentRefs) {
      lines.push(formatAttachmentRefLine(ref));
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

async function loadPromptChatMessages(currentCardId) {
  const turnScopedMessages = await readEnhancedChatMessages(boardId, currentCardId, 30000, {
    turnId,
    logId,
    mcpServerUrl,
  });

  if (Array.isArray(turnScopedMessages) && turnScopedMessages.length > 0) {
    return turnScopedMessages;
  }

  return readChatMessagesViaMcp(boardId, currentCardId, {
    logId,
    turnId,
    mcpServerUrl,
  });
}

function findAssistantMessage(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim().length > 0) {
      return message;
    }
  }

  return null;
}

function buildCombinedRepairPrompt(cardIdValue) {
  return [
    'The previous attempt did not produce an acceptable result. Fix the issues below before completing.',
    'No final assistant reply was observed through provide-final-reply-to-user.',
    `Write the final user-visible reply using cardId: ${cardIdValue} and the runtime turnId.`,
    'Use provide-final-reply-to-user exactly once.',
    'Do not return reply text through stdout or any other response channel.'
  ].join('\n');
}

function runCopilot(prompt, workingDir, options = {}) {
  const { continueSession = false, onCleanupDeferred = null } = options;
  const ts = Date.now();
  const tempRoot = scratchDir;
  const outFile = agentOutputFile || path.join(tempRoot, `asst-out-${ts}.txt`);
  const errFile = path.join(tempRoot, `asst-err-${ts}.txt`);

  function cleanupWatchpartyFiles() {
    if (agentWatchpartyCardDir) {
      try {
        fs.rmSync(agentWatchpartyCardDir, { recursive: true, force: true });
      } catch {}
      return;
    }
    if (typeof outFile === 'string' && outFile.trim()) {
      try { fs.unlinkSync(outFile); } catch {}
    }
  }

  cleanupWatchpartyFiles();

  if (typeof onCleanupDeferred === 'function') {
    onCleanupDeferred(cleanupWatchpartyFiles);
  }

  return new Promise((resolve, reject) => {
  const copilotArgs = [
    '-C', workingDir,
    '-s',
    '--no-ask-user',
    '--allow-all-tools',
    '--model', COPILOT_MODEL,
  ];
  if (continueSession) {
    copilotArgs.splice(2, 0, '--continue');
  }
  const execCommand = process.platform === 'win32' ? 'cmd.exe' : 'copilot';
  const execArgs = process.platform === 'win32'
    ? ['/d', '/c', 'copilot', ...copilotArgs]
    : copilotArgs;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(path.dirname(errFile), { recursive: true });
  const outStream = fs.createWriteStream(outFile, { flags: 'w' });
  const errStream = fs.createWriteStream(errFile, { flags: 'w' });
  outStream.write("Reasoning...\n");
  let settled = false;
  let timeoutId = null;

  const finish = (handler) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    outStream.end(() => {
      errStream.end(() => handler());
    });
  };

  try {
    const child = spawn(execCommand, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });

    child.stdout.on('data', (chunk) => {
      outStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errStream.write(chunk);
    });
    child.on('error', (err) => {
      finish(() => {
        const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
        DBG_LOG('runCopilot:error', {
          message: err?.message ?? String(err),
          errFileText: errorText || undefined,
        });
        appendDebug('runCopilot:error', {
          message: err?.message ?? String(err),
          errFileText: errorText || undefined,
        });
        reject(errorText ? new Error(errorText) : err);
      });
    });
    child.on('close', (code, signal) => {
      finish(() => {
        const outputText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
        const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
        if (code === 0) {
          resolve(outputText);
          return;
        }
        reject(new Error(errorText || `copilot exited with code ${code ?? 'unknown'}`));
      });
    });

    timeoutId = setTimeout(() => {
      child.kill();
    }, chatCopilotTimeoutMs);
    child.stdin.end(prompt);
  } catch (err) {
    finish(() => {
      const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
      DBG_LOG('runCopilot:error', {
        message: err?.message ?? String(err),
        errFileText: errorText || undefined,
      });
      appendDebug('runCopilot:error', {
        message: err?.message ?? String(err),
        errFileText: errorText || undefined,
      });
      reject(errorText ? new Error(errorText) : err);
    });
  }
  }).finally(() => {
    try { fs.unlinkSync(errFile); } catch {}
  });
}

async function readAssistantMessageForTurn(cardIdValue) {
  const turnMessages = await readChatMessagesViaMcp(boardId, cardIdValue, {
    logId,
    turnId,
    mcpServerUrl,
  });
  return findAssistantMessage(turnMessages);
}

async function runCopilotWithValidationRetries(prompt, workingDir, cardIdValue) {
  const maxRetries = 3;
  let attempt = 0;
  let assistantMessage = null;

  while (attempt <= maxRetries) {
    let cleanupAfterRead = () => {};
    await runCopilot(
      attempt === 0 ? prompt : buildCombinedRepairPrompt(cardIdValue),
      workingDir,
      {
        continueSession: attempt > 0,
        onCleanupDeferred: (fn) => { cleanupAfterRead = fn; },
      },
    );
    assistantMessage = await readAssistantMessageForTurn(cardIdValue);
    try { cleanupAfterRead(); } catch {}
    if (assistantMessage) {
      break;
    }

    attempt += 1;
  }

  if (!assistantMessage) {
    throw new Error("copilot couldn't produce a valid response");
  }

  return assistantMessage;
}

requireRequiredStrings({
  baseRef,
  cardId,
  logId,
  turnId,
  aiWorkspaceRoot,
  cardStoreRef,
  scratchStoreRef,
}, 'assistant');

appendDebug('assistant:start', {
  boardId,
  cardId,
  turnId,
  baseRef,
  aiWorkspaceRoot,
  cardStoreRef,
  scratchStoreRef,
  scratchDir,
  chatCopilotTimeoutMs,
});
DBG_LOG('assistant:start', {
  boardId,
  cardId,
  turnId,
  aiWorkspaceRoot,
  enableDebugLogging: ENABLE_DEBUG_LOGGING,
});

const workspaceStem = await resolveWorkspaceStem();
const workingDir = resolveCopilotWorkspaceDirByStem(aiWorkspaceRoot, workspaceStem, 'assistant');
const promptChatMessages = await loadPromptChatMessages(cardId);
const turnTranscript = formatChatTranscript(promptChatMessages, cardId);
const prompt = buildPrompt(cardId, logId, turnTranscript);
appendDebug('assistant:promptBuilt', {
  workingDir,
  workspaceStem,
  promptMessageCount: Array.isArray(promptChatMessages) ? promptChatMessages.length : 0,
  historyDumpLength: turnTranscript.length,
  promptLength: prompt.length,
  prompt,
});

try {
  if (bypassCopilotForTest) {
    // Keep the bypass on the same final-reply MCP path as the real assistant flow.
    appendDebug('assistant:testBypass', {
      replyText: 'paris',
    });
    await stageAssistantReplyViaMcp(boardId, cardId, turnId, 'paris', [], { logId, mcpServerUrl });
    process.stdout.write(JSON.stringify({ assistantHandled: true, bypassed: true }));
    process.exit(0);
  }

  const assistantMessage = await runCopilotWithValidationRetries(
    prompt,
    workingDir,
    cardId,
  );
  const assistantResponseText = typeof assistantMessage?.text === 'string'
    ? assistantMessage.text
    : '';
  appendDebug('assistant:success', {
    publishedAttachmentCount: Array.isArray(assistantMessage?.files) ? assistantMessage.files.length : 0,
    assistantResponseText,
    turnId,
  });
  DBG_LOG('assistant:success', {
    publishedAttachmentCount: Array.isArray(assistantMessage?.files) ? assistantMessage.files.length : 0,
    assistantResponseText,
    turnId,
  });
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  appendDebug('assistant:error', {
    message: err?.message ?? String(err),
  });
  DBG_LOG('assistant:error', {
    message: err?.message ?? String(err),
  });
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
