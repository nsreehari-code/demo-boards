#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendAssistantReply,
  clearFinalResponseContainer,
  configureWorkspaceCliScripts,
  createFinalResponseContainerFromRoot,
  publishFinalResponseFromContainer,
  readEnhancedChatMessages,
  readStagedFinalResponse,
  readJsonStdin,
  requireRequiredStrings,
  resolveCopilotWorkspaceDir,
  resolveStoreDir,
} from './shared.js';

const COPILOT_MODEL = 'gpt-5.4';
const PROMPT_LAST_USER_TURNS = 4;

function sanitizeWatchpartyToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function getCopilotOutputFileName(cardId) {
  return `${sanitizeWatchpartyToken(cardId)}-copilot-output.txt`;
}

function resolveCopilotOutputFilePath(dirPath, cId) {
  return path.join(dirPath, getCopilotOutputFileName(cId));
}

function resolveCopilotToolsLogFilePath(dirPath, cId) {
  return path.join(dirPath, `${sanitizeWatchpartyToken(cId)}-copilot-tools.txt`);
}

const extra = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  baseRef = '',
  aiWorkspaceRoot = '',
  cardStoreRef = '',
  chatStoreRef = '',
  artifactsStoreRef = '',
  scratchStoreRef = '',
  finalResponseRootDir = '',
  watchPartyFilesForChatDir = '',
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;
const bypassCopilotForTest = process.env.DEMO_T3A_BYPASS === '1';
const ENABLE_DEBUG_LOGGING = typeof process.env.ENABLE_DEBUG_LOGGING === 'string' ? process.env.ENABLE_DEBUG_LOGGING.trim() : '';
const DEBUG_LOG_PATH = ENABLE_DEBUG_LOGGING || path.join(os.tmpdir(), 'demo-board-t3a-assistant-debug.log');

const scratchDir = scratchStoreRef ? resolveStoreDir(scratchStoreRef, 'scratchStoreRef') : '';
const DEBUG_LOG_FILE = scratchDir ? path.join(scratchDir, 'assistant-debug.jsonl') : '';
const copilotOutputFile = watchPartyFilesForChatDir ? resolveCopilotOutputFilePath(watchPartyFilesForChatDir, cardId) : '';
const chatCardWatchPartyFile = watchPartyFilesForChatDir ? resolveCopilotToolsLogFilePath(watchPartyFilesForChatDir, cardId) : '';

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
  if (!DEBUG_LOG_FILE) {
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

function buildPrompt(cId, historyDump) {
  const instructionsBlock = [
    'You are the responder in a three way orchestration.',
    'I am only a mediator passing the runtime context and the user query to you.',
    'The user only sees rendered card data (card definitions from card-store-cli and runtime outputs from board-live-cards-cli)  and exposed board status and the chat messages/attachments.',
    'If you need more history or other runtime context (user attached files, chat histories, card definitions, runtime outputs, board status), hill-climb and side-walk conservatively: fetch the minimum additional context needed using the existing CLI surfaces, runtime handles, and appropriate skills.',
    'Use the runtime handles below directly when you need operational context.',
    `If you need to inspect the file attachment contents, run: "node inspect-file-contents.js --card-id <cardId> --file-idx <fileIndex>"`,
    'IF you have the required response, then immediately Use the provide-final-reply-to-user skill exactly once to stage the final user-visible assistant reply and any generated attachments.',
    'Do not expose internal orchestration details, logs, handles, refs, paths, directory names, or implementation notes.',
    'Do not include markdown fences. No Fluff.',
    'After completing the main task, use the `lore-keeper` agent when the interaction could potentially have durable board-level, user-level, identity, or decision knowledge that should persist across future tasks.',
  ].join(' ');

  const runtimeHandlesBlock = [
    'Runtime handles:',
    `- boardId: \"${boardId || '(not provided)'}\"`,
    `- cardId / card-id: \"${cId}\"`,
  ].join('\n');

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
    '',
    `Recent chat context and the current user Query towards the end:`,
    historyDump,
  ].join('\n');
}

function parseSystemMessageFileIndex(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*.*?#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) {
    return null;
  }

  const fileIndex = Number.parseInt(match[2], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return null;
  }

  return fileIndex;
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
  const text = typeof message.text === 'string' && message.text.trim()
    ? message.text.trim()
    : '(no text)';
  const lines = [`${roleLabel}:`, text];

  if (role === 'system') {
    const fileIndex = parseSystemMessageFileIndex(text);
    if (fileIndex !== null) {
      lines.push(`card-id:${currentCardId} file-index:${fileIndex}`);
    }
  }

  return lines.join('\n');
}

function formatChatTranscript(messages, currentCardId) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'No recent chat messages.';
  }

  return messages
    .map((message) => formatTranscriptMessage(message, currentCardId))
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .join('\n\n');
}

function findNewAssistantMessage(messages, priorCount) {
  if (!Array.isArray(messages) || !Number.isInteger(priorCount) || priorCount < 0) {
    return null;
  }

  for (let index = messages.length - 1; index >= priorCount; index -= 1) {
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
    'No staged final reply was written through provide-final-reply-to-user.',
    `Write the final user-visible reply using cardId: ${cardIdValue}.`,
    'Do not return reply text through stdout or any other response channel.'
  ].join('\n');
}

function runCopilot(prompt, workingDir, options = {}) {
  const { continueSession = false } = options;
  const ts = Date.now();
  const tempRoot = scratchDir;
  const outFile = copilotOutputFile || path.join(tempRoot, `asst-out-${ts}.txt`);
  const errFile = path.join(tempRoot, `asst-err-${ts}.txt`);
  const cleanupFiles = [outFile, chatCardWatchPartyFile].filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0);

  function cleanupWatchpartyFiles() {
    for (const filePath of cleanupFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, '', 'utf-8');
        }
      } catch {}
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }

  cleanupWatchpartyFiles();

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
  const childEnv = chatCardWatchPartyFile
    ? { ...process.env, CHAT_CARD_WATCH_PARTY_FILE: chatCardWatchPartyFile }
    : process.env;
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
      env: childEnv,
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
    cleanupWatchpartyFiles();
    try { fs.unlinkSync(errFile); } catch {}
  });
}

async function runCopilotWithValidationRetries(prompt, workingDir, cardIdValue, responseFilePath) {
  const maxRetries = 3;
  let attempt = 0;
  let stagedFinalReply = '';

  while (attempt <= maxRetries) {
    await runCopilot(
      attempt === 0 ? prompt : buildCombinedRepairPrompt(cardIdValue),
      workingDir,
      { continueSession: attempt > 0 },
    );
    stagedFinalReply = readStagedFinalResponse(responseFilePath);

    if (stagedFinalReply) {
      break;
    }

    attempt += 1;
  }

  if (!stagedFinalReply) {
    throw new Error("copilot couldn't produce a valid response");
  }

  return {
    stagedFinalReply,
  };
}

requireRequiredStrings({
  baseRef,
  cardId,
  aiWorkspaceRoot,
  cardStoreRef,
  chatStoreRef,
  scratchStoreRef,
  finalResponseRootDir,
}, 'assistant');

appendDebug('assistant:start', {
  boardId,
  cardId,
  baseRef,
  aiWorkspaceRoot,
  cardStoreRef,
  chatStoreRef,
  artifactsStoreRef,
  scratchStoreRef,
  scratchDir,
  chatCopilotTimeoutMs,
});
DBG_LOG('assistant:start', {
  boardId,
  cardId,
  chatStoreRef,
  scratchStoreRef,
  aiWorkspaceRoot,
  enableDebugLogging: ENABLE_DEBUG_LOGGING,
});

const workingDir = resolveCopilotWorkspaceDir(aiWorkspaceRoot, cardStoreRef, cardId, 'assistant');
configureWorkspaceCliScripts(workingDir, 'assistant');
const chatMessages = readEnhancedChatMessages(
  baseRef,
  chatStoreRef,
  cardId,
  Math.min(chatCopilotTimeoutMs, 30000),
  { lastUserTurns: PROMPT_LAST_USER_TURNS },
);
const historyDump = formatChatTranscript(chatMessages, cardId);
const finalResponseContainer = createFinalResponseContainerFromRoot(finalResponseRootDir, cardId);
clearFinalResponseContainer(finalResponseContainer.containerDir);
const prompt = buildPrompt(cardId, historyDump);
appendDebug('assistant:promptBuilt', {
  workingDir,
  historyDumpLength: historyDump.length,
  promptLength: prompt.length,
  prompt,
});

try {
  if (bypassCopilotForTest) {
    // User-visible assistant text must be written through chat store only.
    appendDebug('assistant:testBypass', {
      replyText: 'paris',
    });
    appendAssistantReply(chatStoreRef, cardId, 'paris', Math.min(chatCopilotTimeoutMs, 30000));
    process.stdout.write(JSON.stringify({ assistantHandled: true, bypassed: true }));
    process.exit(0);
  }

  const runResult = await runCopilotWithValidationRetries(
    prompt,
    workingDir,
    cardId,
    finalResponseContainer.responseFilePath
  );
  const stagedFinalReply = runResult.stagedFinalReply;

  if (!stagedFinalReply) {
    throw new Error("copilot couldn't produce a valid response");
  }
  const publishResult = publishFinalResponseFromContainer({
    baseRef,
    chatStoreRef,
    cardStoreRef,
    artifactsStoreRef,
    cardId,
    containerDir: finalResponseContainer.containerDir,
    replyText: stagedFinalReply,
    timeoutMs: Math.min(chatCopilotTimeoutMs, 30000),
  });
  appendDebug('assistant:success', {
    usedFallbackAppend: false,
    publishedAttachmentCount: publishResult.publishedAttachmentCount,
  });
  DBG_LOG('assistant:success', {
    usedFallbackAppend: false,
    publishedAttachmentCount: publishResult.publishedAttachmentCount,
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
