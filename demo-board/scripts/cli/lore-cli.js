#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LORE_FILE = path.resolve(process.cwd(), 'lore', 'kb.json');

const HELP_TEXT = [
  'lore-cli - read and write a lightweight lore knowledge base',
  '',
  '  lore-cli get --key <key> [--file <path>]',
  '    Print one lore entry or null.',
  '',
  '  lore-cli get-all [--file <path>] [--include-deprecated]',
  '    Print all lore entries.',
  '',
  '  lore-cli set --key <key> --value-json <json> [--file <path>]',
  '    Create or replace one lore entry value.',
  '',
  '  lore-cli append --key <key> (--value <text> | --value-json <json>) [--file <path>]',
  '    Append text to an existing entry or create it if missing.',
  '',
  '  lore-cli deprecate --key <key> [--file <path>]',
  '    Mark one lore entry as deprecated.',
  '',
  '  lore-cli delete --key <key> [--file <path>]',
  '    Remove one lore entry completely.',
  '',
  '  lore-cli --stdin',
  '    Read a JSON command envelope from stdin:',
  '    { "command": "get|get-all|set|append|deprecate|delete", "file": "lore/kb.json", ... }',
].join('\n');

function printHelp() {
  console.error(HELP_TEXT);
}

function requireArgValue(args, name, usageSuffix) {
  const index = args.indexOf(name);
  const value = index !== -1 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing ${name}\nUsage: ${usageSuffix}`);
  }
  return value;
}

function optionalArgValue(args, name) {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readJsonStdin() {
  const raw = fs.readFileSync(0, 'utf-8').trim();
  if (!raw) {
    throw new Error('stdin is empty');
  }
  return JSON.parse(raw);
}

function ensureLoreShape(loreDb) {
  if (!loreDb || typeof loreDb !== 'object' || Array.isArray(loreDb)) {
    return { entries: [] };
  }
  if (!Array.isArray(loreDb.entries)) {
    return { ...loreDb, entries: [] };
  }
  return loreDb;
}

function loadLoreDb(filePath) {
  const resolved = path.resolve(filePath || DEFAULT_LORE_FILE);
  if (!fs.existsSync(resolved)) {
    return { filePath: resolved, loreDb: { entries: [] } };
  }

  const raw = fs.readFileSync(resolved, 'utf-8').trim();
  if (!raw) {
    return { filePath: resolved, loreDb: { entries: [] } };
  }

  return { filePath: resolved, loreDb: ensureLoreShape(JSON.parse(raw)) };
}

function saveLoreDb(filePath, loreDb) {
  const resolved = path.resolve(filePath || DEFAULT_LORE_FILE);
  const nextLoreDb = ensureLoreShape(loreDb);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tempFile = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(nextLoreDb, null, 2), 'utf-8');
  fs.renameSync(tempFile, resolved);
  return resolved;
}

function normalizeKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('key is required');
  }
  return key.trim();
}

function loreGet(loreDb, key) {
  const normalizedKey = normalizeKey(key);
  return ensureLoreShape(loreDb).entries.find((entry) => entry.key === normalizedKey) || null;
}

function loreGetAll(loreDb, options = {}) {
  const entries = ensureLoreShape(loreDb).entries;
  if (options.includeDeprecated === true) {
    return [...entries];
  }
  return entries.filter((entry) => entry.deprecated !== true);
}

function loreSet(loreDb, key, value) {
  const normalizedKey = normalizeKey(key);
  const nextLoreDb = ensureLoreShape(loreDb);
  const now = new Date().toISOString();
  const existing = nextLoreDb.entries.find((entry) => entry.key === normalizedKey);

  if (existing) {
    existing.value = value;
    existing.deprecated = false;
    existing.updatedAt = now;
    return { created: false, entry: structuredClone(existing) };
  }

  const entry = {
    key: normalizedKey,
    value,
    deprecated: false,
    createdAt: now,
    updatedAt: now,
  };
  nextLoreDb.entries.push(entry);
  return { created: true, entry: structuredClone(entry) };
}

function appendLoreValue(previousValue, nextValue) {
  if (typeof previousValue === 'string' && typeof nextValue === 'string') {
    return previousValue ? `${previousValue}\n${nextValue}` : nextValue;
  }

  if (Array.isArray(previousValue) && Array.isArray(nextValue)) {
    return [...previousValue, ...nextValue];
  }

  if (Array.isArray(previousValue)) {
    return [...previousValue, nextValue];
  }

  if (Array.isArray(nextValue)) {
    return [previousValue, ...nextValue];
  }

  return [previousValue, nextValue];
}

function loreAppend(loreDb, key, value) {
  const normalizedKey = normalizeKey(key);
  const nextLoreDb = ensureLoreShape(loreDb);
  const now = new Date().toISOString();
  const existing = nextLoreDb.entries.find((entry) => entry.key === normalizedKey);

  if (existing) {
    existing.value = appendLoreValue(existing.value, value);
    existing.deprecated = false;
    existing.updatedAt = now;
    return { created: false, entry: structuredClone(existing) };
  }

  const entry = {
    key: normalizedKey,
    value,
    deprecated: false,
    createdAt: now,
    updatedAt: now,
  };
  nextLoreDb.entries.push(entry);
  return { created: true, entry: structuredClone(entry) };
}

function loreDeprecate(loreDb, key) {
  const existing = loreGet(loreDb, key);
  if (!existing) {
    throw new Error(`Lore entry "${key}" not found.`);
  }
  existing.deprecated = true;
  existing.updatedAt = new Date().toISOString();
  return { entry: structuredClone(existing) };
}

function loreDelete(loreDb, key) {
  const normalizedKey = normalizeKey(key);
  const nextLoreDb = ensureLoreShape(loreDb);
  const index = nextLoreDb.entries.findIndex((entry) => entry.key === normalizedKey);
  if (index === -1) {
    throw new Error(`Lore entry "${normalizedKey}" not found.`);
  }
  const [removed] = nextLoreDb.entries.splice(index, 1);
  return { entry: structuredClone(removed) };
}

function parseValue(args, allowPlainText = false) {
  const valueJson = optionalArgValue(args, '--value-json');
  if (typeof valueJson === 'string') {
    return JSON.parse(valueJson);
  }
  const valueText = optionalArgValue(args, '--value');
  if (allowPlainText && typeof valueText === 'string') {
    return valueText;
  }
  throw new Error('Missing value. Provide --value-json <json> or --value <text> when supported.');
}

function executeCommand(commandEnvelope) {
  const command = typeof commandEnvelope.command === 'string' ? commandEnvelope.command : '';
  const requestedFile = typeof commandEnvelope.file === 'string' && commandEnvelope.file.trim().length > 0
    ? commandEnvelope.file
    : DEFAULT_LORE_FILE;
  const { filePath, loreDb } = loadLoreDb(requestedFile);

  switch (command) {
    case 'get': {
      const entry = loreGet(loreDb, commandEnvelope.key);
      return { file: filePath, entry };
    }
    case 'get-all': {
      const entries = loreGetAll(loreDb, { includeDeprecated: commandEnvelope.includeDeprecated === true });
      return { file: filePath, count: entries.length, entries };
    }
    case 'set': {
      const result = loreSet(loreDb, commandEnvelope.key, commandEnvelope.value);
      saveLoreDb(filePath, loreDb);
      return { file: filePath, ...result };
    }
    case 'append': {
      const result = loreAppend(loreDb, commandEnvelope.key, commandEnvelope.value);
      saveLoreDb(filePath, loreDb);
      return { file: filePath, ...result };
    }
    case 'deprecate': {
      const result = loreDeprecate(loreDb, commandEnvelope.key);
      saveLoreDb(filePath, loreDb);
      return { file: filePath, ...result };
    }
    case 'delete': {
      const result = loreDelete(loreDb, commandEnvelope.key);
      saveLoreDb(filePath, loreDb);
      return { file: filePath, ...result };
    }
    default:
      throw new Error(`Unknown command: ${command || '(missing)'}`);
  }
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return;
  }

  if (argv[0] === '--stdin') {
    const envelope = readJsonStdin();
    printResult(executeCommand(envelope));
    return;
  }

  const command = argv[0];
  const args = argv.slice(1);
  const file = optionalArgValue(args, '--file') || DEFAULT_LORE_FILE;

  switch (command) {
    case 'get': {
      const key = requireArgValue(args, '--key', 'lore-cli get --key <key> [--file <path>]');
      printResult(executeCommand({ command, file, key }));
      return;
    }
    case 'get-all': {
      printResult(executeCommand({ command, file, includeDeprecated: hasFlag(args, '--include-deprecated') }));
      return;
    }
    case 'set': {
      const key = requireArgValue(args, '--key', 'lore-cli set --key <key> --value-json <json> [--file <path>]');
      const value = parseValue(args, false);
      printResult(executeCommand({ command, file, key, value }));
      return;
    }
    case 'append': {
      const key = requireArgValue(args, '--key', 'lore-cli append --key <key> (--value <text> | --value-json <json>) [--file <path>]');
      const value = parseValue(args, true);
      printResult(executeCommand({ command, file, key, value }));
      return;
    }
    case 'deprecate':
    case 'delete': {
      const key = requireArgValue(args, '--key', `lore-cli ${command} --key <key> [--file <path>]`);
      printResult(executeCommand({ command, file, key }));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`lore-cli: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});