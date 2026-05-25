#!/usr/bin/env node

import fs from 'node:fs';

const usageLines = [
  'Usage:',
  '  node inspect-file-contents.js --file-ref <file-ref>',
];

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

function deserializeFsPathRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('b64:')) {
    return null;
  }

  const decoded = JSON.parse(Buffer.from(ref.slice(4), 'base64url').toString('utf8'));
  if (!decoded || decoded.kind !== 'fs-path' || typeof decoded.value !== 'string' || !decoded.value.trim()) {
    throw new Error('Expected --file-ref to be an fs-path ref');
  }

  return decoded.value.trim();
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage(0);
  }

  const fileRef = requireArgText(flags, 'file-ref');
  const resolvedFilePath = deserializeFsPathRef(fileRef) ?? fileRef;

  if (!resolvedFilePath || !fs.existsSync(resolvedFilePath)) {
    throw new Error(`file not found for ref: ${fileRef}`);
  }

  process.stdout.write(fs.readFileSync(resolvedFilePath, 'utf8'));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}