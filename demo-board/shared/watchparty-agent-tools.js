export const WATCHPARTY_AGENT_TOOL_ACTIONS = Object.freeze({
  INVOKING: 'invoking',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const WATCHPARTY_AGENT_TOOL_ACTION_SET = new Set(Object.values(WATCHPARTY_AGENT_TOOL_ACTIONS));
const LEGACY_ACTION_PREFIXES = Object.freeze({
  invoking: WATCHPARTY_AGENT_TOOL_ACTIONS.INVOKING,
  completed: WATCHPARTY_AGENT_TOOL_ACTIONS.COMPLETED,
  failed: WATCHPARTY_AGENT_TOOL_ACTIONS.FAILED,
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function normalizeLegacyToolName(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return '';
  return normalized.includes('.') ? normalized : `liveboards.${normalized}`;
}

function normalizePayloadToolName(value) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  return normalized.includes('.') ? normalized : normalizeLegacyToolName(normalized);
}

function parseLegacyWatchpartyAgentToolLine(value) {
  const line = normalizeString(value);
  if (!line) return null;

  const match = /^(Invoking|Completed|Failed)\s+'([^']+)'(?:\s+(.*))?$/i.exec(line);
  if (!match) {
    return null;
  }

  const [, rawAction, rawToolName, rawDetails = ''] = match;
  const normalizedAction = LEGACY_ACTION_PREFIXES[rawAction.toLowerCase()] || '';
  const normalizedToolName = normalizeLegacyToolName(rawToolName);
  if (!normalizedAction || !normalizedToolName) {
    return null;
  }

  const cardMatch = /\bfor\s+([A-Za-z0-9._-]+)/i.exec(rawDetails);
  const fileMatch = /\bfile(?:\s+no\.)?\s+(\d+)\b/i.exec(rawDetails);

  return buildWatchpartyAgentToolPayload({
    tool: normalizedToolName,
    card_id: cardMatch?.[1],
    file_idx: fileMatch?.[1],
    action: normalizedAction,
  });
}

export function normalizeWatchpartyAgentToolAction(value) {
  const normalized = normalizeString(value).toLowerCase();
  return WATCHPARTY_AGENT_TOOL_ACTION_SET.has(normalized) ? normalized : '';
}

export function buildWatchpartyAgentToolPayload({ tool, card_id, turn_id, file_idx, action } = {}) {
  const normalizedTool = normalizePayloadToolName(tool);
  const normalizedAction = normalizeWatchpartyAgentToolAction(action);
  if (!normalizedTool || !normalizedAction) {
    return null;
  }

  const payload = {
    tool: normalizedTool,
    action: normalizedAction,
  };

  const normalizedCardId = normalizeString(card_id);
  if (normalizedCardId) payload.card_id = normalizedCardId;

  const normalizedTurnId = normalizeString(turn_id);
  if (normalizedTurnId) payload.turn_id = normalizedTurnId;

  const normalizedFileIdx = normalizeOptionalInt(file_idx);
  if (normalizedFileIdx !== undefined) payload.file_idx = normalizedFileIdx;

  return payload;
}

export function parseWatchpartyAgentToolPayloads(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return [];
    try {
      return parseWatchpartyAgentToolPayloads(JSON.parse(normalized));
    } catch {
      return normalized
        .split(/\r?\n/g)
        .map((line) => parseLegacyWatchpartyAgentToolLine(line))
        .filter(Boolean);
    }
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseWatchpartyAgentToolPayloads(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (!('tool' in value) && typeof value.text === 'string') {
    return parseWatchpartyAgentToolPayloads(value.text);
  }

  const payload = buildWatchpartyAgentToolPayload({
    tool: value.tool,
    card_id: value.card_id ?? value.cardId,
    turn_id: value.turn_id ?? value.turnId ?? value.turn,
    file_idx: value.file_idx ?? value.fileIdx,
    action: value.action ?? value.action_enum ?? value.action_string,
  });
  return payload ? [payload] : [];
}

export function parseWatchpartyAgentToolPayload(value) {
  return parseWatchpartyAgentToolPayloads(value)[0] ?? null;
}