#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendAssistantReply,
  createCardStoreSnapshot,
  hasValidationIssues,
  readChatMessages,
  readJsonStdin,
  readStoredCard,
  requireRequiredStrings,
  resolveStoreDir,
  syncChangedCardsToBoard,
  validateAllCards,
} from './shared.js';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_BAT = path.join(HANDLER_DIR, 'copilot_wrapper.bat');

const extra = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  baseRef = '',
  boardSetupRoot = '',
  cardStoreRef = '',
  chatStoreRef = '',
  artifactsStoreRef = '',
  scratchStoreRef = '',
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;

const scratchDir = scratchStoreRef ? resolveStoreDir(scratchStoreRef, 'scratchStoreRef') : '';
const DEBUG_LOG_FILE = scratchDir ? path.join(scratchDir, 'assistant-debug.jsonl') : '';

function buildPrompt(cId, historyDump) {
  const instructionsBlock = [
    'You are the responder in a three way orchestration.',
    'I am only a mediator passing the runtime context and the user query to you.',
    'The user only sees rendered card data (card definitions from card-store-cli and runtime outputs from board-live-cards-cli)  and exposed board status.',
    'Do not expose internal orchestration details, logs, handles, refs, paths, directory names, or implementation notes.',
    'Use the runtime handles below directly when you need operational context.',
    'Do not spend time rediscovering these handles from files, directories, or scans.',
    'Return only the user-visible final answer text.',
    'Do not return status updates, tool transcripts, internal notes, or completion acknowledgements.',
    'Do not write files, and do not include markdown fences.',
    'When you have the final user-visible answer, write it to chat storage yourself using the local standalone chat-store CLI from the Copilot workspace root.',
    'Append exactly one assistant message containing only the final user-visible answer text.',
    'Use the current skill command surfaces; do not invent alternate CLI forms.',
  ].join(' ');

  const runtimeHandlesBlock = [
    'Runtime handles:',
    `- boardId: ${boardId || '(not provided)'}`,
    `- cardId: ${cId}`,
    `- baseRef: ${baseRef || '(not provided)'}`,
    `- cardStoreRef: ${cardStoreRef || '(not provided)'}`,
    `- chatStoreRef: ${chatStoreRef || '(not provided)'}`,
    `- artifactsStoreRef: ${artifactsStoreRef || '(not provided)'}`,
    `- scratchStoreRef: ${scratchStoreRef || '(not provided)'}`,
  ].join('\n');

  const responseWriteBlock = [
    'Write the final response to the user here:',
    '- from the Copilot workspace root, use:',
    `- node ./.github/scripts/chat-store-cli.js append --store-ref "${chatStoreRef || '(not provided)'}" --card-id "${cId}" --role assistant --text "<final-user-reply>" --files-json "[]"`,
    '- append exactly one final assistant reply and nothing else.',
  ].join('\n');

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
    '',
    responseWriteBlock,
    '',
    'Chat history dump:',
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

function buildValidationRepairPrompt(issuesByCardId) {
  return [
    'The following validations issues surfaced on the cards. Please fix them.',
    JSON.stringify(issuesByCardId),
  ].join('\n');
}

function formatCommandForLog(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(' ');
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

function runCopilot(prompt, workingDir) {
  const ts = Date.now();
  const tempRoot = scratchDir || process.cwd();
  const promptFile = path.join(tempRoot, `asst-prompt-${ts}.txt`);
  const outFile = path.join(tempRoot, `asst-out-${ts}.txt`);
  const errFile = path.join(tempRoot, `asst-err-${ts}.txt`);
  const effectiveWorkingDir = workingDir || process.cwd();
  const execArgs = [
    '/d', '/c', WRAPPER_BAT,
    effectiveWorkingDir,
    promptFile,
    outFile,
    errFile,
  ];
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    appendDebug('runCopilot:beforeExec', {
      cwd: process.cwd(),
      tempRoot,
      promptFile,
      outFile,
      errFile,
      copilotWorkingDir: effectiveWorkingDir,
      copilotCmd: formatCommandForLog('cmd.exe', execArgs),
      promptLength: prompt.length,
    });
    execFileSync('cmd.exe', execArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: chatCopilotTimeoutMs,
      windowsHide: true,
    });
    const outputText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
    const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
    appendDebug('runCopilot:afterExec', {
      outputLength: outputText.length,
      errorLength: errorText.length,
      outFileExists: fs.existsSync(outFile),
      errFileExists: fs.existsSync(errFile),
    });
    return outputText;
  } catch (err) {
    const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
    appendDebug('runCopilot:error', {
      message: err?.message ?? String(err),
      errFileText: errorText || undefined,
      stderr: typeof err?.stderr === 'string' ? err.stderr.trim() : undefined,
      stdout: typeof err?.stdout === 'string' ? err.stdout.trim() : undefined,
    });
    if (errorText) {
      throw new Error(errorText);
    }
    throw err;
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
    try { fs.unlinkSync(errFile); } catch {}
    appendDebug('runCopilot:cleanup', {
      promptFileRemoved: !fs.existsSync(promptFile),
      outFileRemoved: !fs.existsSync(outFile),
      errFileRemoved: !fs.existsSync(errFile),
    });
  }
}

function runValidationRepair(workingDir, issuesByCardId) {
  const repairPrompt = buildValidationRepairPrompt(issuesByCardId);
  appendDebug('runValidationRepair:start', {
    issueCardCount: issuesByCardId && typeof issuesByCardId === 'object' ? Object.keys(issuesByCardId).length : 0,
  });
  return runCopilot(repairPrompt, workingDir).trim();
}

function runCopilotWithValidationRetries(prompt, workingDir, setupRoot, storeRef) {
  const initialCardSnapshot = createCardStoreSnapshot(setupRoot, storeRef);
  appendDebug('runCopilotWithValidationRetries:snapshotCreated', {
    hasInitialCardSnapshot: initialCardSnapshot !== null,
  });
  const responseParts = [];
  const initialResponse = runCopilot(prompt, workingDir).trim();
  appendDebug('runCopilotWithValidationRetries:initialResponse', {
    responseLength: initialResponse.length,
  });
  if (initialResponse) {
    responseParts.push(initialResponse);
  }

  let retries = 0;
  while (retries < 3) {
    const validationIssuesByCardId = validateAllCards(setupRoot, storeRef, Math.min(chatCopilotTimeoutMs, 30000));
    appendDebug('runCopilotWithValidationRetries:validationCheck', {
      retryIndex: retries,
      hasValidationIssues: hasValidationIssues(validationIssuesByCardId),
      issueCardCount: validationIssuesByCardId && typeof validationIssuesByCardId === 'object'
        ? Object.keys(validationIssuesByCardId).length
        : 0,
    });
    if (!hasValidationIssues(validationIssuesByCardId)) {
      break;
    }

    const repairResponse = runValidationRepair(workingDir, validationIssuesByCardId);
    appendDebug('runCopilotWithValidationRetries:repairResponse', {
      retryIndex: retries,
      responseLength: repairResponse.length,
    });
    if (repairResponse) {
      responseParts.push(repairResponse);
    }
    retries += 1;
  }

  const finalValidationIssuesByCardId = validateAllCards(setupRoot, storeRef, Math.min(chatCopilotTimeoutMs, 30000));
  appendDebug('runCopilotWithValidationRetries:finalValidation', {
    hasValidationIssues: hasValidationIssues(finalValidationIssuesByCardId),
    issueCardCount: finalValidationIssuesByCardId && typeof finalValidationIssuesByCardId === 'object'
      ? Object.keys(finalValidationIssuesByCardId).length
      : 0,
  });
  if (hasValidationIssues(finalValidationIssuesByCardId)) {
    throw new Error(`Card validation failed after Copilot run\n${JSON.stringify(finalValidationIssuesByCardId)}`);
  }

  syncChangedCardsToBoard(initialCardSnapshot);
  appendDebug('runCopilotWithValidationRetries:syncChangedCardsToBoard', {
    responsePartCount: responseParts.length,
  });

  return responseParts.join('\n\n');
}

function resolveCopilotRoot(storeRef, cId) {
  const storedCard = readStoredCard(storeRef, cId, Math.min(chatCopilotTimeoutMs, 30000));
  return storedCard?.meta?.ingest === true ? 'gandalf' : 'default';
}

function resolveCopilotWorkingDir(setupRoot, storeRef, cId) {
  const copilotRoot = resolveCopilotRoot(storeRef, cId);
  const workspaceDir = setupRoot
    ? path.join(setupRoot, 'copilot-workspaces', copilotRoot)
    : '';
  if (workspaceDir && fs.existsSync(workspaceDir)) {
    return workspaceDir;
  }
  const workspaceDefaultDir = setupRoot
    ? path.join(setupRoot, 'copilot-workspaces', 'default')
    : '';
  if (workspaceDefaultDir && fs.existsSync(workspaceDefaultDir)) {
    return workspaceDefaultDir;
  }
  return setupRoot || process.cwd();
}

requireRequiredStrings({
  cardId,
  boardSetupRoot,
  cardStoreRef,
  chatStoreRef,
  scratchStoreRef,
}, 'assistant');

appendDebug('assistant:start', {
  boardId,
  cardId,
  baseRef,
  boardSetupRoot,
  cardStoreRef,
  chatStoreRef,
  artifactsStoreRef,
  scratchStoreRef,
  scratchDir,
  chatCopilotTimeoutMs,
});

const chatMessages = readChatMessages(chatStoreRef, cardId, Math.min(chatCopilotTimeoutMs, 30000));
appendDebug('assistant:initialChatMessages', {
  chatMessageCount: Array.isArray(chatMessages) ? chatMessages.length : -1,
});
const historyDump = JSON.stringify(chatMessages, null, 2);
const workingDir = resolveCopilotWorkingDir(boardSetupRoot, cardStoreRef, cardId);
appendDebug('assistant:workingDirResolved', {
  workingDir,
});
const prompt = buildPrompt(cardId, historyDump);
appendDebug('assistant:promptBuilt', {
  historyDumpLength: historyDump.length,
  promptLength: prompt.length,
});

try {
  const assistantReplyText = runCopilotWithValidationRetries(
    prompt,
    workingDir,
    boardSetupRoot,
    cardStoreRef
  );
  appendDebug('assistant:copilotRunCompleted', {
    assistantReplyLength: assistantReplyText.length,
  });
  const updatedChatMessages = readChatMessages(chatStoreRef, cardId, Math.min(chatCopilotTimeoutMs, 30000));
  appendDebug('assistant:updatedChatMessages', {
    updatedChatMessageCount: Array.isArray(updatedChatMessages) ? updatedChatMessages.length : -1,
  });
  const appendedAssistantMessage = findNewAssistantMessage(updatedChatMessages, chatMessages.length);
  appendDebug('assistant:appendedAssistantMessageCheck', {
    foundAppendedAssistantMessage: !!appendedAssistantMessage,
  });

  if (!appendedAssistantMessage) {
    if (!assistantReplyText || assistantReplyText.trim().length === 0) {
      throw new Error('Assistant handler did not append a reply and returned an empty response');
    }
    appendDebug('assistant:fallbackAppendAssistantReply', {
      replyLength: assistantReplyText.trim().length,
    });
    appendAssistantReply(chatStoreRef, cardId, assistantReplyText.trim(), Math.min(chatCopilotTimeoutMs, 30000));
  }
  appendDebug('assistant:success', {
    usedFallbackAppend: !appendedAssistantMessage,
  });
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  appendDebug('assistant:error', {
    message: err?.message ?? String(err),
  });
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
