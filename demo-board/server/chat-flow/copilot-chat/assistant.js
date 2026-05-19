#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBoardLiveCardsNonCorePublic } from 'yaml-flow/board-live-cards-public';
import { createCardStore, createCardStorePublic, createFsBoardNonCorePlatformAdapter } from 'yaml-flow/board-live-cards-node';

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
  boardId = '',
  cardId = '',
  baseRef = '',
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
  const chatBoardDir = boardSetupRoot && chatStore
    ? path.join(boardSetupRoot, chatStore)
    : '';
  const instructionsBlock = [
    'You are the responder in a three way orchestration.',
    'I am only a mediator passing the runtime context and the user query to you.',
    'The user only sees rendered card data (card definitions from card-store-cli and runtime outputs from board-live-cards-cli)  and exposed board status.',
    'Do not expose internal orchestration details, logs, handles, refs, paths, directory names, or implementation notes.',
    'Use the runtime handles below directly when you need operational context.',
    'Do not spend time rediscovering these handles from files, directories, or scans.',
    'When you are ready to reply to the user, append exactly one assistant message to chat-store using chat-store-cli append with the provided chatBoardDir and cardId.',
    'The appended message text is the user-visible final answer. Do not append partial drafts, status updates, tool transcripts, or internal notes.',
    'Do not call chat-store set-processing; orchestration clears processing after you finish.',
    'After appending the final assistant message, return only a short completion acknowledgement for orchestration.',
    'Do not write files, and do not include markdown fences or internal notes in the returned acknowledgement.',
  ].join(' ');

  const runtimeHandlesBlock = [
    'Runtime handles:',
    `- boardId: ${boardId || '(not provided)'}`,
    `- cardId: ${cId}`,
    `- baseRef: ${baseRef || '(not provided)'}`,
    `- chatBoardDir: ${chatBoardDir || '(not provided)'}`,
    `- cardStoreRef: ${cardStoreRef || '(not provided)'}`,
    `- chatStoreRef: ${chatStoreRef || '(not provided)'}`,
    `- artifactsStoreRef: ${artifactsStoreRef || '(not provided)'}`,
    `- scratchStoreRef: ${scratchStoreRef || '(not provided)'}`,
  ].join('\n');

  const contextBlock = [
    'Current user query:',
    currentUserText,
  ].join('\n');

  return [
    instructionsBlock,
    '',
    runtimeHandlesBlock,
    '',
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
  const execArgs = [
    '/d', '/c', WRAPPER_BAT,
    outFile,
    os.tmpdir(),
    workingDir || process.cwd(),
    '@' + promptFile,
    'raw',
    'demo-chat',
  ];
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    execFileSync('cmd.exe', execArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: chatCopilotTimeoutMs,
      windowsHide: true,
    });
    const outputText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
    return outputText;
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

function createCardStoreSnapshot(setupRoot, storeRef) {
  if (!setupRoot || !storeRef) {
    return null;
  }

  const boardRef = { kind: 'fs-path', value: setupRoot };
  const boardAdapter = createFsBoardNonCorePlatformAdapter(boardRef);
  const kvStorage = boardAdapter.kvStorageForRef(storeRef);
  const cardAdminStore = createCardStore({
    readIndex() {
      const value = kvStorage.read('_index');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    writeIndex(index) {
      kvStorage.write('_index', index);
    },
    readCard(key) {
      const value = kvStorage.read(key);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    writeCard(key, card) {
      kvStorage.write(key, card);
      return JSON.stringify(card);
    },
    cardExists(key) {
      return kvStorage.read(key) !== null;
    },
    defaultCardKey(currentCardId) {
      return currentCardId;
    },
  });
  const cardStorePublic = createCardStorePublic(cardAdminStore);
  const cardsResult = cardStorePublic.get({});
  const cards = cardsResult.status === 'success' && Array.isArray(cardsResult.data?.cards)
    ? cardsResult.data.cards.filter((card) => card && typeof card === 'object')
    : [];

  return {
    boardApi: createBoardLiveCardsNonCorePublic(boardRef, boardAdapter),
    cardAdminStore,
    cardsById: new Map(
      cards
        .filter((card) => typeof card.id === 'string' && card.id.length > 0)
        .map((card) => [card.id, card])
    ),
    checksumIndex: cardAdminStore.readChecksumIndex(),
  };
}

function syncChangedCardsToBoard(snapshot) {
  if (!snapshot) {
    return;
  }

  const changedCardIds = snapshot.cardAdminStore.changedSince(snapshot.checksumIndex);
  for (const changedCardId of changedCardIds) {
    if (!changedCardId) {
      continue;
    }

    const currentCard = snapshot.cardAdminStore.readCard(changedCardId);
    if (currentCard) {
      const upsertResult = snapshot.boardApi.upsertCard({
        params: { cardId: changedCardId, restart: true },
      });
      if (upsertResult.status !== 'success') {
        throw new Error(upsertResult.error ?? `Failed to refresh changed card "${changedCardId}"`);
      }
      continue;
    }

    if (!snapshot.cardsById.has(changedCardId)) {
      continue;
    }

    const removeResult = snapshot.boardApi.removeCard({
      params: { id: changedCardId },
    });
    if (removeResult.status !== 'success') {
      throw new Error(removeResult.error ?? `Failed to remove deleted card "${changedCardId}" from board runtime`);
    }
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
  const initialCardSnapshot = createCardStoreSnapshot(setupRoot, storeRef);
  const responseParts = [];
  const initialResponse = runCopilot(prompt, workingDir).trim();
  if (initialResponse) {
    responseParts.push(initialResponse);
  }

  let retries = 0;
  while (retries < 3) {
    const validationIssuesByCardId = validateAllCards(setupRoot, storeRef);
    if (!hasValidationIssues(validationIssuesByCardId)) {
      break;
    }

    const repairResponse = runValidationRepair(workingDir, validationIssuesByCardId);
    if (repairResponse) {
      responseParts.push(repairResponse);
    }
    retries += 1;
  }

  const finalValidationIssuesByCardId = validateAllCards(setupRoot, storeRef);
  if (hasValidationIssues(finalValidationIssuesByCardId)) {
    throw new Error(`Card validation failed after Copilot run\n${JSON.stringify(finalValidationIssuesByCardId)}`);
  }

  syncChangedCardsToBoard(initialCardSnapshot);

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
  runCopilotWithValidationRetries(
    prompt,
    workingDir,
    boardSetupRoot,
    cardStoreRef
  );
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
