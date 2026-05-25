#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = path.join(__dirname, 'board-live-cards-cli.mjs');
const chatStoreCliPath = path.join(__dirname, 'chat-store-cli.mjs');

const usageLines = [
  'Usage:',
  '  cat payload.json | node provide-response-to-user.js --base-ref <board-ref> --card-id <card-id>',
  '',
  'Payload shape:',
  '  { "text": "<final-assistant-reply>", "files": [] }',
];

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
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

  return flags;
}

function requireArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    printUsage(1);
  }

  return flags[key].trim();
}

function readPayload() {
  if (process.stdin.isTTY) {
    printUsage(1);
  }

  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) {
    throw new Error('stdin payload is required');
  }

  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('stdin payload must be a JSON object');
  }

  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('payload.text must be a non-empty string');
  }

  if (payload.files !== undefined && !Array.isArray(payload.files)) {
    throw new Error('payload.files must be an array when provided');
  }

  return {
    text: payload.text,
    files: Array.isArray(payload.files) ? payload.files : [],
  };
}

function runJsonScript(scriptPath, scriptArgs) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
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

function runTextScript(scriptPath, scriptArgs) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }

  return result.stdout.trim();
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage(0);
  }

  const baseRef = requireArgText(flags, 'base-ref');
  const cardId = requireArgText(flags, 'card-id');
  const payload = readPayload();
  const chatStoreRef = readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');

  const appendResult = runTextScript(chatStoreCliPath, [
    'append',
    '--store-ref',
    chatStoreRef,
    '--card-id',
    cardId,
    '--role',
    'assistant',
    '--text',
    payload.text,
    '--files-json',
    JSON.stringify(payload.files),
  ]);

  let parsedAppendResult = null;
  if (appendResult) {
    parsedAppendResult = JSON.parse(appendResult);
  }

  printJson({
    status: 'success',
    data: {
      cardId,
      append_result: parsedAppendResult,
    },
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}