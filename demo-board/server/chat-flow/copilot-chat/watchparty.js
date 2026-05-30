import path from 'node:path';

export function sanitizeWatchpartyToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

export function deriveLogIdFromCardId(cardId) {
  return `0${sanitizeWatchpartyToken(cardId)}`;
}

export function deriveCardIdFromLogId(logId) {
  const normalized = typeof logId === 'string' ? logId.trim() : '';
  if (!normalized.startsWith('0')) {
    return '';
  }

  const cardToken = normalized.slice(1).trim();
  if (!cardToken) {
    return '';
  }

  return sanitizeWatchpartyToken(cardToken);
}

export const AGENT_OUTPUT_FILE_STEM = 'agent-output.txt';
export const AGENT_TOOLS_FILE_STEM = 'agent-tools.txt';

export function getAgentOutputFileName(cardId) {
  return path.join(sanitizeWatchpartyToken(cardId), AGENT_OUTPUT_FILE_STEM);
}

export function getAgentToolsLogFileName(cardId) {
  return path.join(sanitizeWatchpartyToken(cardId), AGENT_TOOLS_FILE_STEM);
}

export function resolveAgentWatchpartyCardDir(dirPath, cardId) {
  return path.join(dirPath, sanitizeWatchpartyToken(cardId));
}

export function resolveAgentOutputFilePath(dirPath, cardId) {
  return path.join(resolveAgentWatchpartyCardDir(dirPath, cardId), AGENT_OUTPUT_FILE_STEM);
}

export function resolveAgentToolsLogFilePath(dirPath, cardId) {
  return path.join(resolveAgentWatchpartyCardDir(dirPath, cardId), AGENT_TOOLS_FILE_STEM);
}

export function parseAgentWatchpartyRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;
  const [cardToken, fileName] = parts;
  if (!cardToken || !fileName) return null;
  const cardId = sanitizeWatchpartyToken(cardToken);
  if (fileName === AGENT_OUTPUT_FILE_STEM) return { cardId, fileStem: AGENT_OUTPUT_FILE_STEM };
  if (fileName === AGENT_TOOLS_FILE_STEM) return { cardId, fileStem: AGENT_TOOLS_FILE_STEM };
  return null;
}