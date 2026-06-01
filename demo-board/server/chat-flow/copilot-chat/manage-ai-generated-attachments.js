import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { callLiveboardsTool } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FINAL_RESPONSE_FILE_NAME = '001-response.txt';

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

async function uploadArtifact(boardId, cardId, fileName, filePath, mimeType, logId) {
  const text = fs.readFileSync(filePath, 'utf8');
  return callLiveboardsTool('liveboards.manage.upload-card-file', {
    board_id: boardId,
    card_id: cardId,
    file_name: fileName,
    ...(mimeType ? { content_type: mimeType } : {}),
    text,
    ...(typeof logId === 'string' && logId.trim() ? { log_id: logId.trim() } : {}),
  });
}

async function appendSystemMessage(boardId, cardId, messageText, turnId = '', logId = '') {
  return callLiveboardsTool('liveboards.stage-ai-response-and-any-attachments', {
    card_id: cardId,
    turn_id: turnId,
    text: '',
    files: [],
    ...(typeof logId === 'string' && logId.trim() ? { log_id: logId.trim() } : {}),
  });
}

export async function publishStagedAttachments({
  boardId,
  cardId,
  attachmentsContainerDir,
  turnId = '',
  logId = '',
}) {
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
  const published = [];
  for (const [offset, stagedFile] of stagedFiles.entries()) {
    const storedName = buildStoredName(stagedFile.displayName, offset);
    const stat = fs.statSync(stagedFile.filePath);
    const mimeType = inferMimeType(stagedFile.displayName);

    const uploadResult = await uploadArtifact(boardId, cardId, stagedFile.displayName, stagedFile.filePath, mimeType, logId);
    const fileData = uploadResult?.data && typeof uploadResult.data === 'object' ? uploadResult.data : uploadResult;
    published.push({
      name: stagedFile.displayName,
      stored_name: storedName,
      size: stat.size,
      ...(mimeType ? { mime_type: mimeType } : {}),
      uploaded_at: uploadedAt,
      chat: true,
      upload: fileData,
    });
  }

  return {
    status: 'success',
    data: {
      cardId,
      attachmentsContainerDir,
      published,
    },
  };
}
