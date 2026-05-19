#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBoardLiveCardsNonCorePublic } from 'yaml-flow/board-live-cards-public';
import { createFsBoardNonCorePlatformAdapter } from 'yaml-flow/board-live-cards-node';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_BAT = path.join(HANDLER_DIR, 'copilot_wrapper.bat');
const require = createRequire(import.meta.url);
const YAML_FLOW_PACKAGE_JSON = require.resolve('yaml-flow/package.json');
const CARD_STORE_CLI = path.join(path.dirname(YAML_FLOW_PACKAGE_JSON), 'cli', 'node', 'card-store-cli.js');

function readJsonStdin() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const extra = readJsonStdin();
const {
  cardId = '',
  boardSetupRoot = '',
  boardRuntimeDir = '',
  cardStore = 'cards-store',
  cardStoreRef = '',
  chatStore = 'cards-chats',
  chatStoreRef = '',
  runtimeStatusDir = '',
  artifactsStore = '',
  artifactsStoreRef = '',
  scratchStore = 'scratch',
  scratchStoreRef = '',
  chatMessages: rawChatMessages = [],
  userText = 'what is two plus two?',
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatMessages = Array.isArray(rawChatMessages) ? rawChatMessages : [];
const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;


function buildPrompt(cId, historyDump, currentUserText) {
  const cardSetupDirRel = path.join(artifactsStore, cId).replace(/\\/g, '/');
  const runtimeDirRel = boardRuntimeDir;
  const statusDirRel = runtimeStatusDir;

  const contextBlock = [
    'We are currently doing a three way orchestration.',
    'You are the responder who has context of the cards in ' + cardSetupDirRel + ',',
    'card runtime statuses in ' + runtimeDirRel + ',',
    'and computed outputs in ' + statusDirRel + '.',
    'I am just a mediator passing on the query.',
    'The user sees the data available in cards which is rendered, and the status from ' + statusDirRel + '.',
    'Everything else is internal detail not to be exposed to the user.',
    'The conversation history is provided below exactly as received from the runtime API as a string dump.',
    'The current user query is: ' + currentUserText,
    'Return only the assistant response text for the user.',
    'Do not write files, and do not include any internal notes, logs, or orchestration details in the response.',
  ].join(' ');

  return [
    contextBlock,
    '',
    'Chat history dump:',
    historyDump,
    '',
    'Assistant response:',
  ].join('\n');
}

function buildValidationRepairPrompt(issuesByCardId) {
  return [
    'The following validations issues surfaced on the cards. Please fix them.',
    JSON.stringify(issuesByCardId),
  ].join('\n');
}

function runCopilot(prompt, workingDir) {
  const ts = Date.now();
  const promptFile = path.join(os.tmpdir(), `asst-prompt-${ts}.txt`);
  const outFile = path.join(os.tmpdir(), `asst-out-${ts}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    execFileSync('cmd.exe', [
      '/d', '/c', WRAPPER_BAT,
      outFile,
      os.tmpdir(),
      workingDir || process.cwd(),
      '@' + promptFile,
      'raw',
      'demo-chat',
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: chatCopilotTimeoutMs,
      windowsHide: true,
    });
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

function readStoredCard(storeRef, cId) {
  if (!storeRef || !cId) return null;
  try {
    const raw = execFileSync(process.execPath, [
      CARD_STORE_CLI,
      'get',
      '--store-ref',
      storeRef,
      '--id',
      cId,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: Math.min(chatCopilotTimeoutMs, 30000),
      windowsHide: true,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : null;
  } catch {
    return null;
  }
}

function readAllStoredCards(storeRef) {
  if (!storeRef) return [];
  try {
    const raw = execFileSync(process.execPath, [
      CARD_STORE_CLI,
      'get',
      '--store-ref',
      storeRef,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: Math.min(chatCopilotTimeoutMs, 30000),
      windowsHide: true,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((card) => card && typeof card === 'object') : [];
  } catch {
    return [];
  }
}

function validateAllCards(setupRoot, storeRef) {
  if (!setupRoot || !storeRef) {
    return {};
  }

  const cards = readAllStoredCards(storeRef);
  if (cards.length === 0) {
    return {};
  }

  const boardRef = { kind: 'fs-path', value: setupRoot };
  const boardApi = createBoardLiveCardsNonCorePublic(
    boardRef,
    createFsBoardNonCorePlatformAdapter(boardRef)
  );

  const issuesByCardId = {};
  for (const card of cards) {
    const currentCardId = typeof card.id === 'string' ? card.id : '';
    if (!currentCardId) {
      issuesByCardId['(unknown)'] = ['Card from card-store-cli is missing a string id'];
      continue;
    }

    const validation = boardApi.validateCardPreflight({
      body: card,
    });

    if (validation.status !== 'success') {
      issuesByCardId[currentCardId] = [validation.error ?? 'validateCardPreflight failed'];
      continue;
    }

    const result = validation.data && typeof validation.data === 'object'
      ? validation.data
      : null;
    if (!result) {
      issuesByCardId[currentCardId] = ['validateCardPreflight returned no result for card'];
      continue;
    }

    if (!result.isValid) {
      const failedCardId = result.cardId || currentCardId;
      const issues = Array.isArray(result.issues) ? result.issues : ['Unknown validation failure'];
      if (issues.length > 0) {
        issuesByCardId[failedCardId] = issues;
      }
    }
  }

  return issuesByCardId;
}

function hasValidationIssues(issuesByCardId) {
  return Object.keys(issuesByCardId).length > 0;
}

function runValidationRepair(workingDir, issuesByCardId) {
  const repairPrompt = buildValidationRepairPrompt(issuesByCardId);
  return runCopilot(repairPrompt, workingDir).trim();
}

function runCopilotWithValidationRetries(prompt, workingDir, setupRoot, storeRef) {
  const responseParts = [];
  const initialResponse = runCopilot(prompt, workingDir).trim();
  if (!initialResponse) {
    throw new Error('Copilot returned an empty response');
  }
  responseParts.push(initialResponse);

  let retries = 0;
  while (retries < 3) {
    const validationIssuesByCardId = validateAllCards(setupRoot, storeRef);
    if (!hasValidationIssues(validationIssuesByCardId)) {
      break;
    }

    const repairResponse = runValidationRepair(workingDir, validationIssuesByCardId);
    if (!repairResponse) {
      throw new Error('Copilot returned an empty repair response');
    }
    responseParts.push(repairResponse);
    retries += 1;
  }

  const finalValidationIssuesByCardId = validateAllCards(setupRoot, storeRef);
  if (hasValidationIssues(finalValidationIssuesByCardId)) {
    throw new Error(`Card validation failed after Copilot run\n${JSON.stringify(finalValidationIssuesByCardId)}`);
  }

  return responseParts.join('\n\n');
}

function resolveCopilotRoot(storeRef, cId) {
  const storedCard = readStoredCard(storeRef, cId);
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

const historyDump = JSON.stringify(chatMessages, null, 2);
const workingDir = resolveCopilotWorkingDir(boardSetupRoot, cardStoreRef, cardId);
const prompt = buildPrompt(cardId, historyDump, userText.trim());

try {
  const replyText = runCopilotWithValidationRetries(
    prompt,
    workingDir,
    boardSetupRoot,
    cardStoreRef
  );
  process.stdout.write(JSON.stringify({ replyText }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
