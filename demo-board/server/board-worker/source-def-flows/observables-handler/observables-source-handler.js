#!/usr/bin/env node

import {
  deriveLogIdFromCardId,
  invokeMcpServerTool,
  resolveAgentFaceMcpUrl,
} from '../../../chat-flow/shared.js';

/**
 * observables-source-handler.js — Observe the hosting board's own runtime status.
 *
 * This is the "external compute" half of the observatory pattern: it reads live
 * board state that is NOT exposed to cards as tokens (per-card task status,
 * requires/provides wiring, completion counts) by calling the board's own
 * controlplane inspection tool server-side, then reduces it into a compact,
 * deterministic observation.
 *
 * It deliberately does NOT compute a "value" or band anything — that stays as
 * declarative jsonata `compute` on the observatory card, so the value formula
 * can be tuned without code changes. This handler only returns raw readings.
 *
 * Read path: the same agentface MCP surface agents use for liveboards.* tools.
 *   serverUrl + agentFaceMcp -> liveboards.inspect.board-runtime-status
 *   arguments { board_id, log_id }
 *   -> { meta, summary, cards: [ { "card-id", status, requires,
 *        requires_satisfied, requires_missing, provides_declared,
 *        provides_runtime } ] }
 */

const DEFAULT_SCOPE = 'board-runtime';
const DEFAULT_TIMEOUT_MS = 15_000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveServerContext(context) {
  const extra = (context && typeof context.extra === 'object' && context.extra) || {};
  const serverUrl = normalizeString(context?.serverUrl) || normalizeString(extra.serverUrl);
  const boardId = normalizeString(extra.boardId);
  const cardId = normalizeString(context?.cardId)
    || normalizeString(extra.cardId)
    || normalizeString(extra.card_id)
    || normalizeString(context?.sourceDef?.cardId)
    || normalizeString(context?.sourceDef?.card_id);
  const agentFaceMcp = normalizeString(extra.agentFaceMcp)
    || normalizeString(extra.agentFaceMcpPath)
    || normalizeString(extra.agentface)
    || '/agent/mcp';
  return { serverUrl, boardId, cardId, agentFaceMcp };
}

function deriveSourceLogId({ cardId, bindTo }) {
  if (cardId) {
    return deriveLogIdFromCardId(cardId);
  }
  const normalizedBindTo = normalizeString(bindTo).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalizedBindTo ? `0${normalizedBindTo}` : '0observables';
}

function resolveExcludeIds(cfg, sourceDef) {
  const raw = cfg?.excludeCardIds;
  if (Array.isArray(raw)) {
    return new Set(raw.filter((id) => typeof id === 'string' && id).map((id) => id.trim()));
  }
  // Allow a projection key that resolves to an array of ids.
  if (typeof raw === 'string' && raw) {
    const projected = sourceDef?._projections?.[raw];
    if (Array.isArray(projected)) {
      return new Set(projected.filter((id) => typeof id === 'string' && id).map((id) => id.trim()));
    }
  }
  return new Set();
}

async function fetchBoardRuntimeStatus(context, { serverUrl, agentFaceMcp, boardId, logId }) {
  const timeoutMs = Number.isFinite(context?.timeoutMs) ? context.timeoutMs : DEFAULT_TIMEOUT_MS;
  const call = invokeMcpServerTool(
    { serverUrl, agentFaceMcp },
    'liveboards.inspect.board-runtime-status',
    { board_id: boardId, log_id: logId },
  );

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      const target = resolveAgentFaceMcpUrl({ serverUrl, agentFaceMcp }) || '(missing agentface url)';
      reject(new Error(`liveboards.inspect.board-runtime-status timed out after ${timeoutMs}ms via ${target}`));
    }, timeoutMs);
  });

  const payload = await Promise.race([call, timeout]);
  if (!payload || payload.status !== 'success' || !payload.data || typeof payload.data !== 'object') {
    throw new Error('liveboards.inspect.board-runtime-status returned no data');
  }
  if (payload.data.status === 'success' && payload.data.data && typeof payload.data.data === 'object') {
    return payload.data.data;
  }
  return payload.data;
}

function reduceObservation(statusPayload, excludeIds) {
  const cards = asArray(statusPayload?.cards).filter((card) => {
    const id = normalizeString(card?.['card-id'] || card?.card_id);
    return id && !excludeIds.has(id);
  });

  const statusCounts = {
    completed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    eligible: 0,
    failed: 0,
    unresolved: 0,
    other: 0,
  };

  let requiresDeclaredTotal = 0;
  let requiresSatisfiedTotal = 0;
  let requiresMissingTotal = 0;
  let providesDeclaredTotal = 0;
  let providesRuntimeTotal = 0;
  let cardsWithMissingRequires = 0;
  let cardsFullySatisfied = 0;

  const failedCardIds = [];
  const blockedCardIds = [];
  const inProgressCardIds = [];

  for (const card of cards) {
    const id = normalizeString(card['card-id'] || card.card_id);
    const status = normalizeString(card.status).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
      statusCounts[status] += 1;
    } else {
      statusCounts.other += 1;
    }

    if (status === 'failed') failedCardIds.push(id);
    if (status === 'blocked') blockedCardIds.push(id);
    if (status === 'in_progress') inProgressCardIds.push(id);

    const requires = asArray(card.requires);
    const requiresSatisfied = asArray(card.requires_satisfied);
    const requiresMissing = asArray(card.requires_missing);
    const providesDeclared = asArray(card.provides_declared);
    const providesRuntime = asArray(card.provides_runtime);

    requiresDeclaredTotal += requires.length;
    requiresSatisfiedTotal += requiresSatisfied.length;
    requiresMissingTotal += requiresMissing.length;
    providesDeclaredTotal += providesDeclared.length;
    providesRuntimeTotal += providesRuntime.length;

    if (requiresMissing.length > 0) cardsWithMissingRequires += 1;
    else cardsFullySatisfied += 1;
  }

  const cardCount = cards.length;
  const settled = statusCounts.in_progress === 0 && statusCounts.pending === 0;

  return {
    card_count: cardCount,
    status_counts: statusCounts,
    completed_count: statusCounts.completed,
    failed_count: statusCounts.failed,
    blocked_count: statusCounts.blocked,
    in_progress_count: statusCounts.in_progress,
    pending_count: statusCounts.pending,
    requires: {
      declared_total: requiresDeclaredTotal,
      satisfied_total: requiresSatisfiedTotal,
      missing_total: requiresMissingTotal,
    },
    provides: {
      declared_total: providesDeclaredTotal,
      runtime_total: providesRuntimeTotal,
    },
    cards_with_missing_requires: cardsWithMissingRequires,
    cards_fully_satisfied: cardsFullySatisfied,
    failed_card_ids: failedCardIds,
    blocked_card_ids: blockedCardIds,
    in_progress_card_ids: inProgressCardIds,
    settled,
  };
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const cfg = (sourceDef.observables && typeof sourceDef.observables === 'object') ? sourceDef.observables : {};
  const scope = normalizeString(cfg.scope) || DEFAULT_SCOPE;

  if (scope !== DEFAULT_SCOPE) {
    const msg = `observables: unsupported scope "${scope}" (only "${DEFAULT_SCOPE}" is implemented)`;
    return { result: 'failure', data: { error: msg }, error: msg };
  }

  const { serverUrl, boardId, cardId, agentFaceMcp } = resolveServerContext(context);
  if (!serverUrl || !boardId) {
    const msg = 'observables: serverUrl/boardId unavailable in executor extra';
    return { result: 'failure', data: { error: msg }, error: msg };
  }

  const timeoutMs = typeof cfg.timeout === 'number' && cfg.timeout > 0 ? cfg.timeout : DEFAULT_TIMEOUT_MS;
  const excludeIds = resolveExcludeIds(cfg, sourceDef);
  const logId = deriveSourceLogId({
    cardId: normalizeString(cfg.cardId) || cardId,
    bindTo: sourceDef?.bindTo,
  });

  try {
    const statusPayload = await fetchBoardRuntimeStatus({ timeoutMs }, {
      serverUrl,
      agentFaceMcp,
      boardId,
      logId,
    });
    const observation = reduceObservation(statusPayload, excludeIds);
    const resultValue = {
      scope,
      board_id: boardId || null,
      log_id: logId,
      observed_at: new Date().toISOString(),
      excluded_card_ids: Array.from(excludeIds),
      ...observation,
    };
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = String(err?.message || err);
    return { result: 'failure', data: { error: msg }, error: msg };
  }
}
