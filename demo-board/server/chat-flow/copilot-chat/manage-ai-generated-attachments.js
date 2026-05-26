#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveStoreDir } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScriptsDir = path.resolve(__dirname, '../../../scripts/cli');
const require = createRequire(import.meta.url);
const yamlFlowBundledCliDir = path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));
const boardLiveCardsCliPath = path.join(yamlFlowBundledCliDir, 'board-live-cards-cli.mjs');
const bundledBoardLiveCardsCliPath = path.join(yamlFlowBundledCliDir, 'board-live-cards-cli.mjs');
const artifactsStoreCliPath = path.join(yamlFlowBundledCliDir, 'artifacts-store-cli.mjs');
const chatStoreCliPath = path.join(yamlFlowBundledCliDir, 'chat-store-cli.mjs');
const manageLiveBoardCardCliPath = path.join(cliScriptsDir, 'manage-live-board-card.js');

const FINAL_RESPONSE_FILE_NAME = '001-response.txt';
const usageLines = [
  'Usage:',
  '  node manage-ai-generated-attachments.js --base-ref <board-ref> --card-id <card-id> --attachments-container-ref <fs-path-ref>',
  '',
  'Publishes every staged file in the container except 001-response.txt as AI-generated chat attachments.',
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

function readOptionalArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    return '';
  }

  return flags[key].trim();
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

  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

function sanitizeStoredNameSegment(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const sanitized = normalized
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'attachment.bin';
}

function inferDisplayName(fileName) {
  const match = /^100-file-\d{3}-(.+)$/.exec(fileName);
  if (match && match[1]) {
    return match[1];
  }
  return fileName;
}

function inferMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    default:
      return '';
  }
}

function listStagedAttachmentFiles(containerDir) {
  if (!fs.existsSync(containerDir)) {
    throw new Error(`attachments container does not exist: ${containerDir}`);
  }

  return fs.readdirSync(containerDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => fileName !== FINAL_RESPONSE_FILE_NAME)
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => ({
      fileName,
      filePath: path.join(containerDir, fileName),
      displayName: inferDisplayName(fileName),
    }));
}

function readStoredCard(storeRef, cardId) {
  const result = runJsonScript(manageLiveBoardCardCliPath, ['read-card', '--store-ref', storeRef, '--card-id', cardId]);
  if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') {
    throw new Error(`card ${cardId} was not found in card store`);
  }
  return result[0];
}

function buildStoredName(index, displayName) {
  return `${String(index + 1).padStart(3, '0')}-${sanitizeStoredNameSegment(displayName)}`;
}

function uploadArtifact(artifactsStoreRef, artifactKey, filePath, mimeType) {
  const args = ['put', '--store-ref', artifactsStoreRef, '--key', artifactKey, '--file', filePath];
  if (mimeType) {
    args.push('--content-type', mimeType);
  }
  return runJsonScript(artifactsStoreCliPath, args);
}

function appendSystemMessage(chatStoreRef, cardId, messageText) {
  const raw = runTextScript(chatStoreCliPath, [
    'append',
    '--store-ref', chatStoreRef,
    '--card-id', cardId,
    '--role', 'system',
    '--text', messageText,
    '--files-json', '[]',
  ]);
  return raw ? JSON.parse(raw) : null;
}

function addCardFiles(baseRef, cardId, fileEntries) {
  return runJsonScript(
    bundledBoardLiveCardsCliPath,
    [
      'add-card-files',
      '--base-ref', baseRef,
      '--card-id', cardId,
      '--value-json', JSON.stringify({ files: fileEntries }),
    ],
  );
}

function publishStagedAttachments({
  baseRef,
  cardId,
  attachmentsContainerRef,
  chatStoreRef: explicitChatStoreRef = '',
  cardStoreRef: explicitCardStoreRef = '',
  artifactsStoreRef: explicitArtifactsStoreRef = '',
}) {
  const cardStoreRef = explicitCardStoreRef || readStoreRef(baseRef, 'get-card-store-ref', 'get-card-store-ref');
  const chatStoreRef = explicitChatStoreRef || readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');
  const artifactsStoreRef = explicitArtifactsStoreRef || readStoreRef(baseRef, 'get-artifacts-store-ref', 'get-artifacts-store-ref');
  const containerDir = resolveStoreDir(attachmentsContainerRef, 'attachments-container-ref');
  const stagedFiles = listStagedAttachmentFiles(containerDir);
  const currentCard = readStoredCard(cardStoreRef, cardId);
  const existingFiles = Array.isArray(currentCard?.card_data?.files) ? currentCard.card_data.files : [];

  if (stagedFiles.length === 0) {
    return {
      status: 'success',
      data: {
        cardId,
        attachmentsContainerRef,
        published: [],
      },
    };
  }

  const uploadedAt = new Date().toISOString();
  const published = stagedFiles.map((stagedFile, offset) => {
    const fileIndex = existingFiles.length + offset;
    const storedName = buildStoredName(fileIndex, stagedFile.displayName);
    const artifactKey = `${cardId}/files/${storedName}`;
    const stat = fs.statSync(stagedFile.filePath);
    const mimeType = inferMimeType(stagedFile.displayName);

    uploadArtifact(artifactsStoreRef, artifactKey, stagedFile.filePath, mimeType);

    return {
      index: fileIndex,
      name: stagedFile.displayName,
      stored_name: storedName,
      size: stat.size,
      ...(mimeType ? { mime_type: mimeType } : {}),
      uploaded_at: uploadedAt,
      chat: true,
      _staged_file_path: stagedFile.filePath,
    };
  });

  const addCardFilesResult = addCardFiles(
    baseRef,
    cardId,
    published.map(({ _staged_file_path, index, ...fileEntry }) => fileEntry),
  );

  const addedFiles = Array.isArray(addCardFilesResult?.files_added)
    ? addCardFilesResult.files_added
    : Array.isArray(addCardFilesResult?.data?.files_added)
      ? addCardFilesResult.data.files_added
      : [];

  const messageResults = addedFiles.map((addedFile) => {
    const idx = Number.isInteger(addedFile?.idx) ? addedFile.idx : null;
    const entry = addedFile?.entry && typeof addedFile.entry === 'object' ? addedFile.entry : {};
    const displayName = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : (typeof entry.stored_name === 'string' ? entry.stored_name : 'attachment');
    return {
      file: typeof entry.stored_name === 'string' ? entry.stored_name : displayName,
      message: appendSystemMessage(chatStoreRef, cardId, `AI generated: ${displayName} #${idx}`),
    };
  });

  return {
    status: 'success',
    data: {
      cardId,
      attachmentsContainerRef,
      add_card_files: addCardFilesResult,
      published: addedFiles,
      system_messages: messageResults,
    },
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage(0);
  }

  const result = publishStagedAttachments({
    baseRef: requireArgText(flags, 'base-ref'),
    cardId: requireArgText(flags, 'card-id'),
    attachmentsContainerRef: requireArgText(flags, 'attachments-container-ref'),
    chatStoreRef: readOptionalArgText(flags, 'chat-store-ref'),
    cardStoreRef: readOptionalArgText(flags, 'card-store-ref'),
    artifactsStoreRef: readOptionalArgText(flags, 'artifacts-store-ref'),
  });

  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}