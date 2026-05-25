#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = path.join(__dirname, 'board-live-cards-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-board-runtime-status.js read-status --base-ref <board-ref>',
  '  node inspect-board-runtime-status.js read-data-object --base-ref <board-ref> --output-key <output-key>',
  '  node inspect-board-runtime-status.js read-all-data-objects --base-ref <board-ref>',
  '  node inspect-board-runtime-status.js read-card-computed-values --base-ref <board-ref> --card-id <card-id>',
  '  node inspect-board-runtime-status.js read-all-computed-values --base-ref <board-ref>',
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

function runBoardLiveCardsCli(args) {
  const result = spawnSync(process.execPath, [boardLiveCardsCliPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `board-live-cards-cli.mjs failed with exit code ${result.status}`);
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function reshapeBoardStatus(statusPayload) {
  const summary = statusPayload?.summary ?? {};
  const cards = Array.isArray(statusPayload?.cards) ? statusPayload.cards : [];

  return {
    meta: statusPayload?.meta ?? {},
    summary: {
      card_count: summary.card_count ?? 0,
      completed: summary.completed ?? 0,
      eligible: summary.eligible ?? 0,
      pending: summary.pending ?? 0,
      blocked: summary.blocked ?? 0,
      in_progress: summary.in_progress ?? 0,
      failed: summary.failed ?? 0,
      unresolved: summary.unresolved ?? 0,
    },
    cards: cards.map((card) => ({
      'card-id': card?.name ?? null,
      status: card?.status ?? null,
      error: card?.error ?? null,
      requires: Array.isArray(card?.requires) ? card.requires : [],
      requires_satisfied: Array.isArray(card?.requires_satisfied) ? card.requires_satisfied : [],
      requires_missing: Array.isArray(card?.requires_missing) ? card.requires_missing : [],
      provides_declared: Array.isArray(card?.provides_declared) ? card.provides_declared : [],
      provides_runtime: Array.isArray(card?.provides_runtime) ? card.provides_runtime : [],
    })),
  };
}

function handleReadStatus(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const result = runBoardLiveCardsCli(['status', '--base-ref', baseRef]);
  printJson(reshapeBoardStatus(unwrapSuccessfulEnvelope(result, 'status')));
}

function handleReadDataObject(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const outputKey = requireArgText(flags, 'output-key');
  const result = runBoardLiveCardsCli(['get-outputs', '--base-ref', baseRef, '--type', 'data-object', '--key', outputKey]);
  printJson(unwrapSuccessfulEnvelope(result, 'get-outputs data-object'));
}

function handleReadAllDataObjects(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const result = runBoardLiveCardsCli(['get-outputs', '--base-ref', baseRef, '--type', 'data-object', '--all']);
  printJson(unwrapSuccessfulEnvelope(result, 'get-outputs data-object --all'));
}

function handleReadCardComputedValues(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const cardId = requireArgText(flags, 'card-id');
  const result = runBoardLiveCardsCli(['get-outputs', '--base-ref', baseRef, '--type', 'computed-values', '--key', cardId]);
  printJson(unwrapSuccessfulEnvelope(result, 'get-outputs computed-values'));
}

function handleReadAllComputedValues(flags) {
  const baseRef = requireArgText(flags, 'base-ref');
  const result = runBoardLiveCardsCli(['get-outputs', '--base-ref', baseRef, '--type', 'computed-values', '--all']);
  printJson(unwrapSuccessfulEnvelope(result, 'get-outputs computed-values --all'));
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage(0);
  }

  switch (command) {
    case 'read-status':
      handleReadStatus(flags);
      return;
    case 'read-data-object':
      handleReadDataObject(flags);
      return;
    case 'read-all-data-objects':
      handleReadAllDataObjects(flags);
      return;
    case 'read-card-computed-values':
      handleReadCardComputedValues(flags);
      return;
    case 'read-all-computed-values':
      handleReadAllComputedValues(flags);
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