#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  log_done,
  log_failed,
  log_it,
  readKnownBaseRef,
  resolveKnownYamlFlowCliPath,
} from './shared_helpers.js';

const BOARD_LIVE_CARDS_CLI = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');
const USAGE_LINES = [
  'Usage:',
  '  node inspect-file-contents.js --card-id <card-id> --file-idx <file-idx>',
];

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function printUsage(exitCode = 0) {
  const text = `${USAGE_LINES.join('\n')}\n`;
  (exitCode === 0 ? process.stdout : process.stderr).write(text);
  process.exit(exitCode);
}

function requireTextArg(parsedArgs, key) {
  if (typeof parsedArgs[key] !== 'string' || !parsedArgs[key].trim()) {
    printUsage(1);
  }

  return parsedArgs[key].trim();
}

function requireNonNegativeIntegerArg(parsedArgs, key) {
  const numericValue = Number.parseInt(String(parsedArgs[key]), 10);
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return numericValue;
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { windowsHide: true });
  if (result.error) {
    throw result.error;
  }

  return result;
}

function getAttachmentContent(cardId, fileIdx) {
  const baseRef = readKnownBaseRef();
  const result = runNodeScript(BOARD_LIVE_CARDS_CLI, [
    'get-attachment-content',
    '--base-ref',
    baseRef,
    '--card-id',
    cardId,
    '--file-idx',
    String(fileIdx),
  ]);

  if (result.status !== 0) {
    const stderrText = result.stderr ? result.stderr.toString('utf8').trim() : '';
    throw new Error(stderrText || `Failed to read file contents (exit code ${result.status})`);
  }

  return result.stdout;
}

function main() {
  const rawArgs = process.argv.slice(2);
  log_it('inspect-file-contents.js');

  const parsedArgs = parseArgs(rawArgs);
  if (parsedArgs.help || parsedArgs.h) {
    printUsage(0);
  }

  const cardId = typeof parsedArgs.cardid === 'string' && parsedArgs.cardid.trim()
    ? parsedArgs.cardid.trim()
    : typeof parsedArgs['card-id'] === 'string' && parsedArgs['card-id'].trim()
      ? parsedArgs['card-id'].trim()
      : requireTextArg(parsedArgs, 'cardid');
  const fileIdx = requireNonNegativeIntegerArg(parsedArgs, 'file-idx');

  const stdoutBuffer = getAttachmentContent(cardId, fileIdx);
  process.stdout.write(stdoutBuffer);
  log_done('inspect-file-contents.js');
}

try {
  main();
} catch (error) {
  log_failed('inspect-file-contents.js');
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
