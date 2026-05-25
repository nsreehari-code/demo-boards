#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = path.join(__dirname, 'board-live-cards-cli.mjs');
const cardStoreCliPath = path.join(__dirname, 'card-store-cli.mjs');
const validateCandidateCardPath = path.join(__dirname, 'preflight-validate-candidate-card-definition.js');

const usageLines = [
  'Usage:',
  '  node manage-live-board-card.js read-card --store-ref <store-ref> --card-id <card-id>',
  '  node manage-live-board-card.js read-all-cards --store-ref <store-ref>',
  '  cat payload.json | node manage-live-board-card.js upsert-card --store-ref <store-ref> --base-ref <board-ref> --card-id <card-id>',
  '  node manage-live-board-card.js deprecate --base-ref <board-ref> --card-id <card-id>',
  '',
  'Upsert payload shape:',
  '  { "candidate_card_content": <card> }',
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

function readStdinJson() {
  if (process.stdin.isTTY) {
    return null;
  }

  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : null;
}

function readCandidateCardPayload() {
  const payload = readStdinJson();
  if (!payload) {
    printUsage(1);
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('stdin payload must be a JSON object');
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'candidate_card_content')) {
    throw new Error('payload must include candidate_card_content');
  }

  const candidateCard = payload.candidate_card_content;
  if (candidateCard == null || typeof candidateCard !== 'object' || Array.isArray(candidateCard)) {
    throw new Error('payload candidate_card_content must be a JSON object');
  }

  return candidateCard;
}

function runJsonScript(scriptPath, scriptArgs, payload) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    input: payload === undefined ? undefined : JSON.stringify(payload),
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleReadCard(flags) {
  const storeRef = requireArgText(flags, 'store-ref');
  const cardId = requireArgText(flags, 'card-id');
  const result = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
  printJson(result);
}

function handleReadAllCards(flags) {
  const storeRef = requireArgText(flags, 'store-ref');
  const result = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef]);
  printJson(result);
}

function handleUpsertCard(flags) {
  const storeRef = requireArgText(flags, 'store-ref');
  const baseRef = requireArgText(flags, 'base-ref');
  const cardId = requireArgText(flags, 'card-id');
  const candidateCard = readCandidateCardPayload();

  if (typeof candidateCard.id !== 'string' || !candidateCard.id.trim()) {
    throw new Error('candidate_card_content.id must be a non-empty string');
  }
  if (candidateCard.id !== cardId) {
    throw new Error(`candidate_card_content.id must match --card-id (${cardId})`);
  }

  const validation = runJsonScript(validateCandidateCardPath, [], {
    candidate_card_content: candidateCard,
  });

  if (validation?.status !== 'success' || validation?.data?.isValid !== true) {
    printJson({
      status: 'fail',
      step: 'validate',
      validation,
    });
    process.exit(1);
  }

  const storeUpdate = runJsonScript(cardStoreCliPath, ['set', '--store-ref', storeRef], candidateCard);
  const boardUpdate = runJsonScript(boardLiveCardsCliPath, ['upsert-card', '--base-ref', baseRef, '--card-id', cardId, '--restart']);

  printJson({
    status: 'success',
    data: {
      validation,
      store_update: storeUpdate,
      board_update: boardUpdate,
    },
  });
}

function handleDeprecate(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const cardId = requireArgText(flags, 'card-id');
  const result = runJsonScript(boardLiveCardsCliPath, ['remove-card', '--base-ref', baseRef, '--id', cardId]);
  printJson(result);
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage(0);
  }

  switch (command) {
    case 'read-card':
      handleReadCard(flags);
      return;
    case 'read-all-cards':
      handleReadAllCards(flags);
      return;
    case 'upsert-card':
      handleUpsertCard(flags);
      return;
    case 'deprecate':
      handleDeprecate(flags);
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