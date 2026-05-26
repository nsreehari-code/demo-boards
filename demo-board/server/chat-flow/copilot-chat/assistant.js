#!/usr/bin/env node

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  getCopilotOutputFileName,
} from '../../../../../watchparty-constants.mjs';
import {
  appendAssistantReply,
  configureWorkspaceCliScripts,
  createFinalResponseContainer,
  FINAL_RESPONSE_FILE_NAME,
  publishFinalResponseFromContainer,
  readEnhancedChatMessages,
  readStagedFinalResponse,
  readJsonStdin,
  requireRequiredStrings,
  resolveCopilotWorkspaceDir,
  resolveStoreDir,
  stageFinalResponsePayload,
} from './shared.js';

const COPILOT_MODEL = 'gpt-5.4';
const PROMPT_LAST_USER_TURNS = 4;

function resolveCopilotOutputFilePath(dirPath, cId) {
  return path.join(dirPath, getCopilotOutputFileName(cId));
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

function buildPrompt(cId, historyDump, finalResponseContainerRef) {
  const instructionsBlock = [
    'You are the responder in a three way orchestration.',
    'I am only a mediator passing the runtime context and the user query to you.',
    'The user only sees rendered card data (card definitions from card-store-cli and runtime outputs from board-live-cards-cli)  and exposed board status.',
    'Do not expose internal orchestration details, logs, handles, refs, paths, directory names, or implementation notes.',
    'Use the runtime handles below directly when you need operational context.',
    'Do not spend time rediscovering these handles from files, directories, or scans.',
    'Do not return the final user-visible answer text through stdout or any other response channel.',
    'Do not return status updates, tool transcripts, internal notes, completion acknowledgements, or reply text.',
    'Use the provide-final-reply-to-user skill exactly once to stage the final user-visible assistant reply.',
    'Do not write the final reply directly to chat store and do not invent alternate persistence paths.',
    'Do not include markdown fences.',
    'Use the current skill command surfaces; do not invent alternate CLI forms.',
    `The prompt only includes the suffix returned by chat-store-cli read-all --last-user-turns ${PROMPT_LAST_USER_TURNS}.`,
    'If you need more history or other runtime context, hill-climb conservatively: fetch the minimum additional context needed using the existing CLI surfaces, runtime handles, and appropriate skills.',
    'Do not guess missing context when you can retrieve it directly.',
    'After completing the main task, use the `lore-keeper` agent when the interaction could potentially have durable board-level, user-level, identity, or decision knowledge that should persist across future tasks.',
  ].join(' ');

  const runtimeHandlesBlock = [
    'Runtime handles:',
    `- boardId: ${boardId || '(not provided)'}`,
    `- cardId: ${cId}`,
    `- scratchStoreRef: ${scratchStoreRef || '(not provided)'}`,
    `- finalResponseContainerRef: ${finalResponseContainerRef}`,
  ].join('\n');

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
    '',
    `Recent chat context (chat-store-cli read-all --last-user-turns ${PROMPT_LAST_USER_TURNS}):`,
    historyDump,
    '',
    'Assistant response:',
  ].join('\n');
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

function buildCombinedRepairPrompt(finalResponseContainerRef) {
  return [
    'The previous attempt did not produce an acceptable result. Fix the issues below before completing.',
    'No staged final reply was written through provide-final-reply-to-user.',
    `Write the final user-visible reply using finalResponseContainerRef: ${finalResponseContainerRef}.`,
    'Do not return reply text through stdout or any other response channel.'
  ].join('\n');
}

function runCopilot(prompt, workingDir) {
  const ts = Date.now();
  const tempRoot = scratchDir;
  const outFile = copilotOutputFile || path.join(tempRoot, `asst-out-${ts}.txt`);
  const errFile = path.join(tempRoot, `asst-err-${ts}.txt`);
  return new Promise((resolve, reject) => {
  const copilotArgs = [
    '-C', workingDir,
    '--continue',
    '-s',
    '--no-ask-user',
    '--allow-all-tools',
    '--model', COPILOT_MODEL,
  ];
  const execCommand = process.platform === 'win32' ? 'cmd.exe' : 'copilot';
  const execArgs = process.platform === 'win32'
    ? ['/d', '/c', 'copilot', ...copilotArgs]
    : copilotArgs;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(path.dirname(errFile), { recursive: true });
  const outStream = fs.createWriteStream(outFile, { flags: 'w' });
  const errStream = fs.createWriteStream(errFile, { flags: 'w' });
  outStream.write("Reasoning:\n");
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
    try { fs.unlinkSync(outFile); } catch {}
    try { fs.unlinkSync(errFile); } catch {}
  });
}

async function runCopilotWithValidationRetries(prompt, workingDir, finalResponseContainerRef, responseFilePath) {
  const maxRetries = 3;
  let attempt = 0;
  let stagedFinalReply = '';

  while (attempt <= maxRetries) {
    await runCopilot(attempt === 0 ? prompt : buildCombinedRepairPrompt(finalResponseContainerRef), workingDir);
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
  chatStoreRef,
  cardStoreRef,
  cardId,
  Math.min(chatCopilotTimeoutMs, 30000),
  { lastUserTurns: PROMPT_LAST_USER_TURNS },
);
const historyDump = JSON.stringify(chatMessages, null, 2);
const finalResponseContainer = createFinalResponseContainer(scratchStoreRef, cardId);
const prompt = buildPrompt(cardId, historyDump, finalResponseContainer.containerRef);

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
    finalResponseContainer.containerRef,
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
    finalResponseContainerRef: finalResponseContainer.containerRef,
    containerDir: finalResponseContainer.containerDir,
    replyText: stagedFinalReply,
    timeoutMs: Math.min(chatCopilotTimeoutMs, 30000),
  });
  appendDebug('assistant:success', {
    usedFallbackAppend: false,
    finalResponseContainerRef: finalResponseContainer.containerRef,
    publishedAttachmentCount: publishResult.publishedAttachmentCount,
  });
  DBG_LOG('assistant:success', {
    usedFallbackAppend: false,
    finalResponseContainerRef: finalResponseContainer.containerRef,
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
