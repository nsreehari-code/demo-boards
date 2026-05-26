#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  buildStoredFileIndex,
  enhanceChatMessageWithFileRefs,
  log_it,
  readKnownBaseRef,
  resolveKnownYamlFlowCliPath,
} from './shared_helpers.js';

const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');
const chatStoreCliPath = resolveKnownYamlFlowCliPath('chat-store-cli.mjs');
const cardStoreCliPath = resolveKnownYamlFlowCliPath('card-store-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> get-messages',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> --last-user-turns <n> get-messages',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> --tail <n> get-messages',
];

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = value;
    index += 1;
  }

  return {
    command: positional[0],
    flags,
  };
}

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function requireArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    printUsage(1);
  }

  return flags[key].trim();
}

function parseOptionalPositiveInteger(flags, key) {
  if (flags[key] === undefined) {
    return null;
  }

  const value = Number.parseInt(String(flags[key]), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return value;
}

function runJsonScript(scriptPath, scriptArgs, input) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    input,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

function unwrapSuccessfulEnvelope(result, commandName) {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null;
  }

  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }

  throw new Error(`${commandName} returned an unexpected response shape`);
}

function readStoreRef(baseRef, getterCommand, commandName) {
  const result = runJsonScript(boardLiveCardsCliPath, [getterCommand, '--base-ref', baseRef]);
  const data = unwrapSuccessfulEnvelope(result, commandName);
  const storeRef = data?.storeRef ?? data?.value;
  if (typeof storeRef !== 'string' || !storeRef.trim()) {
    throw new Error(`${commandName} did not return a store ref`);
  }
  return storeRef.trim();
}

function readStoredCard(storeRef, cardId) {
  const result = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`card "${cardId}" not found in card store`);
  }
  return result[0];
}

function readChatRecords(chatStoreRef, cardId, lastUserTurns = null) {
  const scriptArgs = ['read-all', '--store-ref', chatStoreRef, '--card-id', cardId];
  if (lastUserTurns !== null) {
    scriptArgs.push('--last-user-turns', String(lastUserTurns));
  }

  const result = runJsonScript(chatStoreCliPath, scriptArgs);
  const records = Array.isArray(result) ? result : [];
  return records.filter((record) => record && typeof record === 'object');
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleGetMessages(flags) {
  const baseRef = readKnownBaseRef();
  const cardId = requireArgText(flags, 'card-id');
  const lastUserTurns = parseOptionalPositiveInteger(flags, 'last-user-turns');
  const tail = parseOptionalPositiveInteger(flags, 'tail');
  const chatStoreRef = readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');
  const cardStoreRef = readStoreRef(baseRef, 'get-card-store-ref', 'get-card-store-ref');
  const storedCard = readStoredCard(cardStoreRef, cardId);
  const storedFiles = buildStoredFileIndex(storedCard);
  const messages = readChatRecords(chatStoreRef, cardId, lastUserTurns)
    .map((message) => enhanceChatMessageWithFileRefs(message, storedFiles));
  const visibleMessages = tail === null ? messages : messages.slice(-tail);

  printJson({
    cardId,
    messages: visibleMessages,
  });
}

function main() {
  const argv = process.argv.slice(2);
  log_it('inspect-chat-messages-on-cards.js', argv.join(' '));
  const { command, flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }

  switch (command) {
    case 'get-messages':
      handleGetMessages(flags);
      return;
    default:
      printUsage(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}