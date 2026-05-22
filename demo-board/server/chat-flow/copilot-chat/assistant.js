#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
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
const COPILOT_MODEL = 'gpt-5.4';

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
const bypassCopilotForTest = process.env.DEMO_T3A_BYPASS === '1';
const ENABLE_DEBUG_LOGGING = typeof process.env.ENABLE_DEBUG_LOGGING === 'string' ? process.env.ENABLE_DEBUG_LOGGING.trim() : '';
const DEBUG_LOG_PATH = ENABLE_DEBUG_LOGGING || path.join(os.tmpdir(), 'demo-board-t3a-assistant-debug.log');

const scratchDir = scratchStoreRef ? resolveStoreDir(scratchStoreRef, 'scratchStoreRef') : '';
const DEBUG_LOG_FILE = scratchDir ? path.join(scratchDir, 'assistant-debug.jsonl') : '';

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

function buildPrompt(cId, historyDump) {
  const instructionsBlock = [
    'You are the responder in a three way orchestration.',
    'I am only a mediator passing the runtime context and the user query to you.',
    'The user only sees rendered card data (card definitions from card-store-cli and runtime outputs from board-live-cards-cli)  and exposed board status.',
    'Do not expose internal orchestration details, logs, handles, refs, paths, directory names, or implementation notes.',
    'Use the runtime handles below directly when you need operational context.',
    'Do not spend time rediscovering these handles from files, directories, or scans.',
    'Do not return the final user-visible answer text through stdout or any other response channel.',
    'Do not return status updates, tool transcripts, internal notes, completion acknowledgements, or reply text.',
    'Write the final user-visible assistant reply to chat store only.',
    'Do not write files and do not include markdown fences.',
    'Use the current skill command surfaces; do not invent alternate CLI forms.',
    'After completing the main task, use the `lore-keeper` agent when the interaction could potentially have durable board-level, user-level, identity, or decision knowledge that should persist across future tasks.',
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

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
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
    'This is a silent validation-repair pass.',
    'Do not write any assistant reply, status update, or user-visible text to chat store during this pass.',
    'Only repair the affected cards so validation succeeds.',
    'The following validations issues surfaced on the cards. Please fix them.',
    JSON.stringify(issuesByCardId),
  ].join('\n');
}

function buildCombinedRepairPrompt(issuesByCardId, missingChatStoreReply) {
  const promptParts = [
    'The previous attempt did not produce an acceptable result. Fix the issues below before completing.',
  ];

  if (!missingChatStoreReply) {
    promptParts.push(
      'This is a silent validation-repair pass.',
      'Do not write any assistant reply, status update, or user-visible text to chat store during this pass.',
      'Only repair cards and other workspace artifacts needed to satisfy validation.'
    );
  }

  if (hasValidationIssues(issuesByCardId)) {
    promptParts.push(
      'Validation issues surfaced on the cards:',
      JSON.stringify(issuesByCardId)
    );
  }

  if (missingChatStoreReply) {
    promptParts.push(
      'No assistant reply was appended to chat store.',
      'Write the final user-visible reply to chat store only. Do not return reply text through stdout or any other response channel.'
    );
  }

  return promptParts.join('\n');
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
    COPILOT_MODEL,
  ];
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    DBG_LOG('runCopilot:beforeExec', {
      cwd: process.cwd(),
      tempRoot,
      promptFile,
      outFile,
      errFile,
      wrapperBat: WRAPPER_BAT,
      model: COPILOT_MODEL,
      copilotWorkingDir: effectiveWorkingDir,
      execCommand: 'cmd.exe',
      execArgs,
      copilotCmd: formatCommandForLog('cmd.exe', execArgs),
      promptLength: prompt.length,
    });
    appendDebug('runCopilot:beforeExec', {
      cwd: process.cwd(),
      tempRoot,
      promptFile,
      outFile,
      errFile,
      model: COPILOT_MODEL,
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
    DBG_LOG('runCopilot:afterExec', {
      outputLength: outputText.length,
      errorLength: errorText.length,
      outFileExists: fs.existsSync(outFile),
      errFileExists: fs.existsSync(errFile),
    });
    appendDebug('runCopilot:afterExec', {
      outputLength: outputText.length,
      errorLength: errorText.length,
      outFileExists: fs.existsSync(outFile),
      errFileExists: fs.existsSync(errFile),
    });
    return outputText;
  } catch (err) {
    const errorText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : '';
    DBG_LOG('runCopilot:error', {
      message: err?.message ?? String(err),
      errFileText: errorText || undefined,
      stderr: typeof err?.stderr === 'string' ? err.stderr.trim() : undefined,
      stdout: typeof err?.stdout === 'string' ? err.stdout.trim() : undefined,
    });
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
    if (!ENABLE_DEBUG_LOGGING) {
      try { fs.unlinkSync(promptFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      try { fs.unlinkSync(errFile); } catch {}
    }
    DBG_LOG('runCopilot:cleanup', {
      keptTempFiles: !!ENABLE_DEBUG_LOGGING,
      promptFileRemoved: !fs.existsSync(promptFile),
      outFileRemoved: !fs.existsSync(outFile),
      errFileRemoved: !fs.existsSync(errFile),
    });
    appendDebug('runCopilot:cleanup', {
      promptFileRemoved: !fs.existsSync(promptFile),
      outFileRemoved: !fs.existsSync(outFile),
      errFileRemoved: !fs.existsSync(errFile),
    });
  }
}

function runValidationRepair(workingDir, issuesByCardId, missingChatStoreReply = false) {
  const repairPrompt = missingChatStoreReply || hasValidationIssues(issuesByCardId)
    ? buildCombinedRepairPrompt(issuesByCardId, missingChatStoreReply)
    : buildValidationRepairPrompt(issuesByCardId);
  appendDebug('runValidationRepair:start', {
    issueCardCount: issuesByCardId && typeof issuesByCardId === 'object' ? Object.keys(issuesByCardId).length : 0,
    missingChatStoreReply,
  });
  return runCopilot(repairPrompt, workingDir).trim();
}

function runCopilotWithValidationRetries(prompt, workingDir, baseRef, storeRef, currentCardId, initialChatCount) {
  const initialCardSnapshot = createCardStoreSnapshot(baseRef, storeRef);
  appendDebug('runCopilotWithValidationRetries:snapshotCreated', {
    hasInitialCardSnapshot: initialCardSnapshot !== null,
  });
  const maxRetries = 3;
  let attempt = 0;
  let finalValidationIssuesByCardId = {};
  let finalAppendedAssistantMessage = null;

  while (attempt <= maxRetries) {
    const responseText = runCopilot(attempt === 0 ? prompt : buildCombinedRepairPrompt(finalValidationIssuesByCardId, !finalAppendedAssistantMessage), workingDir).trim();
    appendDebug('runCopilotWithValidationRetries:attemptCompleted', {
      attempt,
      responseLength: responseText.length,
    });

    const validationIssuesByCardId = validateAllCards(baseRef, storeRef, Math.min(chatCopilotTimeoutMs, 30000));
    const updatedChatMessages = readChatMessages(chatStoreRef, currentCardId, Math.min(chatCopilotTimeoutMs, 30000));
    const appendedAssistantMessage = findNewAssistantMessage(updatedChatMessages, initialChatCount);
    const missingChatStoreReply = !appendedAssistantMessage;

    appendDebug('runCopilotWithValidationRetries:validationCheck', {
      attempt,
      hasValidationIssues: hasValidationIssues(validationIssuesByCardId),
      issueCardCount: validationIssuesByCardId && typeof validationIssuesByCardId === 'object'
        ? Object.keys(validationIssuesByCardId).length
        : 0,
      missingChatStoreReply,
      updatedChatMessageCount: Array.isArray(updatedChatMessages) ? updatedChatMessages.length : -1,
    });

    finalValidationIssuesByCardId = validationIssuesByCardId;
    finalAppendedAssistantMessage = appendedAssistantMessage;

    if (!hasValidationIssues(validationIssuesByCardId) && appendedAssistantMessage) {
      break;
    }

    if (attempt === maxRetries) {
      break;
    }

    const repairResponse = runValidationRepair(workingDir, validationIssuesByCardId, missingChatStoreReply);
    appendDebug('runCopilotWithValidationRetries:repairResponse', {
      attempt,
      responseLength: repairResponse.length,
      missingChatStoreReply,
    });
    attempt += 1;
  }

  appendDebug('runCopilotWithValidationRetries:finalValidation', {
    hasValidationIssues: hasValidationIssues(finalValidationIssuesByCardId),
    issueCardCount: finalValidationIssuesByCardId && typeof finalValidationIssuesByCardId === 'object'
      ? Object.keys(finalValidationIssuesByCardId).length
      : 0,
    missingChatStoreReply: !finalAppendedAssistantMessage,
  });
  if (hasValidationIssues(finalValidationIssuesByCardId) || !finalAppendedAssistantMessage) {
    appendDebug('runCopilotWithValidationRetries:finalFailure', {
      validationIssuesByCardId: finalValidationIssuesByCardId,
      missingChatStoreReply: !finalAppendedAssistantMessage,
    });
    throw new Error("copilot couldn't produce a valid response");
  }

  syncChangedCardsToBoard(initialCardSnapshot);
  appendDebug('runCopilotWithValidationRetries:syncChangedCardsToBoard', {
    appendedAssistantMessage: true,
  });

  return {
    appendedAssistantMessage: finalAppendedAssistantMessage,
  };
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
  baseRef,
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
DBG_LOG('assistant:start', {
  boardId,
  cardId,
  chatStoreRef,
  scratchStoreRef,
  enableDebugLogging: ENABLE_DEBUG_LOGGING,
});

const chatMessages = readChatMessages(chatStoreRef, cardId, Math.min(chatCopilotTimeoutMs, 30000));
appendDebug('assistant:initialChatMessages', {
  chatMessageCount: Array.isArray(chatMessages) ? chatMessages.length : -1,
});
DBG_LOG('assistant:initialChatMessages', {
  chatMessageCount: Array.isArray(chatMessages) ? chatMessages.length : -1,
});
const historyDump = JSON.stringify(chatMessages, null, 2);
const workingDir = resolveCopilotWorkingDir(boardSetupRoot, cardStoreRef, cardId);
appendDebug('assistant:workingDirResolved', {
  workingDir,
});
DBG_LOG('assistant:workingDirResolved', {
  workingDir,
});
const prompt = buildPrompt(cardId, historyDump);
appendDebug('assistant:promptBuilt', {
  historyDumpLength: historyDump.length,
  promptLength: prompt.length,
});
DBG_LOG('assistant:promptBuilt', {
  historyDumpLength: historyDump.length,
  promptLength: prompt.length,
});

try {
  if (bypassCopilotForTest) {
    appendDebug('assistant:testBypass', {
      replyText: 'paris',
    });
    // User-visible assistant text must be written through chat store only.
    DBG_LOG('assistant:testBypass:beforeAppend', {
      replyText: 'paris',
    });
    appendAssistantReply(chatStoreRef, cardId, 'paris', Math.min(chatCopilotTimeoutMs, 30000));
    DBG_LOG('assistant:testBypass:afterAppend');
    process.stdout.write(JSON.stringify({ assistantHandled: true, bypassed: true }));
    process.exit(0);
  }

  DBG_LOG('assistant:beforeCopilotRun');
  const runResult = runCopilotWithValidationRetries(
    prompt,
    workingDir,
    boardSetupRoot,
    cardStoreRef,
    cardId,
    chatMessages.length
  );
  appendDebug('assistant:copilotRunCompleted', {
    assistantReplyLength: 0,
    appendedAssistantMessage: !!runResult?.appendedAssistantMessage,
  });
  DBG_LOG('assistant:copilotRunCompleted', {
    assistantReplyLength: 0,
    appendedAssistantMessage: !!runResult?.appendedAssistantMessage,
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
    throw new Error("copilot couldn't produce a valid response");
  }
  appendDebug('assistant:success', {
    usedFallbackAppend: false,
  });
  DBG_LOG('assistant:success', {
    usedFallbackAppend: false,
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
