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

export const COPILOT_OUTPUT_FILE_STEM = 'copilot-output.txt';
export const COPILOT_TOOLS_FILE_STEM = 'copilot-tools.txt';

export function getCopilotOutputFileName(cardId) {
  return path.join(sanitizeWatchpartyToken(cardId), COPILOT_OUTPUT_FILE_STEM);
}

export function getCopilotToolsLogFileName(cardId) {
  return path.join(sanitizeWatchpartyToken(cardId), COPILOT_TOOLS_FILE_STEM);
}

export function resolveCopilotWatchpartyCardDir(dirPath, cardId) {
  return path.join(dirPath, sanitizeWatchpartyToken(cardId));
}

export function resolveCopilotOutputFilePath(dirPath, cardId) {
  return path.join(resolveCopilotWatchpartyCardDir(dirPath, cardId), COPILOT_OUTPUT_FILE_STEM);
}

export function resolveCopilotToolsLogFilePath(dirPath, cardId) {
  return path.join(resolveCopilotWatchpartyCardDir(dirPath, cardId), COPILOT_TOOLS_FILE_STEM);
}

export function parseCopilotWatchpartyRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;
  const [cardToken, fileName] = parts;
  if (!cardToken || !fileName) return null;
  const cardId = sanitizeWatchpartyToken(cardToken);
  if (fileName === COPILOT_OUTPUT_FILE_STEM) return { cardId, fileStem: COPILOT_OUTPUT_FILE_STEM };
  if (fileName === COPILOT_TOOLS_FILE_STEM) return { cardId, fileStem: COPILOT_TOOLS_FILE_STEM };
  return null;
}