import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const yamlFlowBundledCliDir = path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));
const boardLiveCardsCliPath = path.join(yamlFlowBundledCliDir, 'board-live-cards-cli.mjs');
const bundledBoardLiveCardsCliPath = path.join(yamlFlowBundledCliDir, 'board-live-cards-cli.mjs');
const artifactsStoreCliPath = path.join(yamlFlowBundledCliDir, 'artifacts-store-cli.mjs');
const chatStoreCliPath = path.join(yamlFlowBundledCliDir, 'chat-store-cli.mjs');

const FINAL_RESPONSE_FILE_NAME = '001-response.txt';

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

function buildStoredName(displayName, offset) {
  const randomToken = randomUUID().replace(/-/g, '').slice(0, 12);
  const prefix = `${Date.now()}${String(offset).padStart(3, '0')}`;
  return `${prefix}-${sanitizeStoredNameSegment(displayName)}-${randomToken}`;
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

export function publishStagedAttachments({
  baseRef,
  cardId,
  attachmentsContainerDir,
  chatStoreRef: explicitChatStoreRef = '',
  artifactsStoreRef: explicitArtifactsStoreRef = '',
}) {
  const chatStoreRef = explicitChatStoreRef || readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');
  const artifactsStoreRef = explicitArtifactsStoreRef || readStoreRef(baseRef, 'get-artifacts-store-ref', 'get-artifacts-store-ref');
  const containerDir = attachmentsContainerDir;
  const stagedFiles = listStagedAttachmentFiles(containerDir);

  if (stagedFiles.length === 0) {
    return {
      status: 'success',
      data: {
        cardId,
        attachmentsContainerDir,
        published: [],
      },
    };
  }

  const uploadedAt = new Date().toISOString();
  const published = stagedFiles.map((stagedFile, offset) => {
    const storedName = buildStoredName(stagedFile.displayName, offset);
    const artifactKey = `${cardId}/files/${storedName}`;
    const stat = fs.statSync(stagedFile.filePath);
    const mimeType = inferMimeType(stagedFile.displayName);

    uploadArtifact(artifactsStoreRef, artifactKey, stagedFile.filePath, mimeType);

    return {
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
    published.map(({ _staged_file_path, ...fileEntry }) => fileEntry),
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
      attachmentsContainerDir,
      add_card_files: addCardFilesResult,
      published: addedFiles,
      system_messages: messageResults,
    },
  };
}
