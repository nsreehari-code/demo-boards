#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = path.join(__dirname, 'board-live-cards-cli.mjs');
const chatStoreCliPath = path.join(__dirname, 'chat-store-cli.mjs');
const cardStoreCliPath = path.join(__dirname, 'card-store-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> get-messages',
  '  node inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> --tail <n> get-messages',
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

function readChatRecords(chatStoreRef, cardId) {
  const result = runJsonScript(chatStoreCliPath, ['read-all', '--store-ref', chatStoreRef, '--card-id', cardId]);
  const records = Array.isArray(result) ? result : [];
  return records.filter((record) => record && typeof record === 'object');
}

function buildStoredFileIndex(storedCard) {
  const files = Array.isArray(storedCard?.card_data?.files) ? storedCard.card_data.files : [];
  return files.filter((fileEntry) => fileEntry && typeof fileEntry === 'object');
}

function enhanceMessage(message, storedFiles) {
  const enhanced = {
    ...message,
  };

  if (Array.isArray(message?.files)) {
    enhanced.file_refs = message.files
      .map((fileEntry) => toPublicFileRef(fileEntry))
      .filter((fileRef) => typeof fileRef === 'string' && fileRef.length > 0);
  }

  if (message?.role === 'system' && typeof message?.text === 'string') {
    const uploadIndexMatch = /file uploaded:.*#(\d+)\s*$/i.exec(message.text);
    if (uploadIndexMatch) {
      const uploadIndex = Number.parseInt(uploadIndexMatch[1], 10);
      if (Number.isInteger(uploadIndex) && uploadIndex > 0) {
        const fileEntry = storedFiles[uploadIndex - 1];
        if (fileEntry) {
          enhanced.file_ref = toPublicFileRef(fileEntry);
        }
      }
    }
  }

  return enhanced;
}

function extractFileRef(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
    return null;
  }

  const candidateKeys = ['path', 'stored_name', 'key', 'file_ref', 'fileRef', 'ref'];
  for (const key of candidateKeys) {
    const value = fileEntry[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function serializeFsPathRef(filePath) {
  return `b64:${Buffer.from(JSON.stringify({ kind: 'fs-path', value: filePath }), 'utf8').toString('base64url')}`;
}

function toPublicFileRef(fileEntry) {
  const candidate = extractFileRef(fileEntry);
  if (typeof candidate !== 'string' || !candidate) {
    return null;
  }

  if (path.isAbsolute(candidate)) {
    return serializeFsPathRef(candidate);
  }

  return candidate;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleGetMessages(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const cardId = requireArgText(flags, 'card-id');
  const tail = parseOptionalPositiveInteger(flags, 'tail');
  const chatStoreRef = readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');
  const cardStoreRef = readStoreRef(baseRef, 'get-card-store-ref', 'get-card-store-ref');
  const storedCard = readStoredCard(cardStoreRef, cardId);
  const storedFiles = buildStoredFileIndex(storedCard);
  const messages = readChatRecords(chatStoreRef, cardId).map((message) => enhanceMessage(message, storedFiles));
  const visibleMessages = tail === null ? messages : messages.slice(-tail);

  printJson({
    cardId,
    messages: visibleMessages,
  });
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
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