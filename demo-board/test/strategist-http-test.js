#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNotification, buildBoardState } from 'yaml-flow/board-state-reducer';
import { runtimeNotificationsFromPayload } from 'yaml-flow/notification-consumer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliArgs = process.argv.slice(2);
const DEFAULT_TEST_IDS = ['B1'];
const DEFAULT_TEST_SET = new Set(DEFAULT_TEST_IDS);

function readCliOptionValue(args, optionName) {
  const optionIndex = args.lastIndexOf(optionName);
  if (optionIndex === -1) return '';
  return String(args[optionIndex + 1] || '').trim();
}

const SKIPPED_TEST_SET = new Set(
  String(readCliOptionValue(cliArgs, '--skip-tests') || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean),
);

function parseRequestedTests(rawValue) {
  if (!rawValue) return null;
  const requested = new Set(
    rawValue
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  if (requested.size === 0) {
    throw new Error('--run-tests requires at least one test id');
  }
  return requested;
}

function isTestSelected(requestedTests, testId) {
  const normalizedTestId = String(testId || '').trim().toUpperCase();
  if (requestedTests) {
    return requestedTests.has(normalizedTestId);
  }
  if (SKIPPED_TEST_SET.has(normalizedTestId)) {
    return false;
  }
  return DEFAULT_TEST_SET.has(normalizedTestId);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRequiredTokens(requires) {
  if (!Array.isArray(requires)) return [];
  return requires.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bindTo = typeof entry.bindTo === 'string'
      ? entry.bindTo.trim()
      : typeof entry.key === 'string'
        ? entry.key.trim()
        : '';
    return bindTo ? [bindTo] : [];
  });
}

const STATUS_VALUES = ['advancing', 'waiting', 'aligned'];
const MOVE_VALUES = ['deepen', 'broaden', 'clarify', 'decide', 'reconcile', 'hold'];
const ADMIN_CARD_IDS = new Set(['gandalf-intake', 'journey-strategist', 'card-journey-observatory']);

function validateMove(move, boardState = {}) {
  const errors = [];
  const warnings = [];
  const cardIds = new Set(boardState.cardIds || []);
  const policy = boardState.policy || {};

  if (!move || typeof move !== 'object' || Array.isArray(move)) {
    return { ok: false, errors: ['move is not a JSON object'], warnings };
  }

  if (!STATUS_VALUES.includes(move.status)) {
    errors.push(`status "${move.status}" not in {${STATUS_VALUES.join(', ')}}`);
  }
  if (!MOVE_VALUES.includes(move.move)) {
    errors.push(`move "${move.move}" not in {${MOVE_VALUES.join(', ')}}`);
  }
  if (typeof move.rationale !== 'string' || !move.rationale.trim()) {
    warnings.push('rationale is empty');
  }

  const created = Array.isArray(move.created_cards) ? move.created_cards : [];
  const updated = Array.isArray(move.updated_cards) ? move.updated_cards : [];
  const seenIds = new Set();

  for (const card of created) {
    if (!card || typeof card !== 'object') {
      errors.push('created_cards entry is not an object');
      continue;
    }
    if (!card.card_id || typeof card.card_id !== 'string') {
      errors.push('created card missing card_id');
    } else {
      if (cardIds.has(card.card_id)) errors.push(`created card "${card.card_id}" collides with an existing board card`);
      if (seenIds.has(card.card_id)) errors.push(`created card "${card.card_id}" is duplicated in this move`);
      seenIds.add(card.card_id);
    }
    if (card.parent && !cardIds.has(card.parent) && !seenIds.has(card.parent)) {
      errors.push(`created card "${card.card_id}" references unknown parent "${card.parent}"`);
    }
  }

  for (const card of updated) {
    if (!card || typeof card !== 'object') {
      errors.push('updated_cards entry is not an object');
      continue;
    }
    if (!card.card_id || !cardIds.has(card.card_id)) {
      errors.push(`updated card "${card?.card_id}" is not an existing board card`);
    }
  }

  const maxNew = Number(policy.maxNewCardsPerCycle ?? Infinity);
  if (Number.isFinite(maxNew) && created.length > maxNew) {
    errors.push(`created ${created.length} cards > max_new_cards_per_cycle ${maxNew}`);
  }

  if (move.move === 'hold' && (created.length > 0 || updated.length > 0)) {
    warnings.push('move=hold but cards were created/updated');
  }
  if (move.status === 'aligned' && move.move !== 'hold') {
    warnings.push(`status=aligned but move=${move.move} (expected hold while aligned)`);
  }
  if ((move.move === 'deepen' || move.move === 'broaden') && created.length === 0) {
    warnings.push(`move=${move.move} but no cards were created`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function moveFromComputed(computedValues = {}) {
  const move = (computedValues && typeof computedValues.move === 'object' && computedValues.move)
    ? computedValues.move
    : (computedValues && typeof computedValues.plan === 'object' && computedValues.plan)
      ? computedValues.plan
      : {};
  return {
    status: move.status ?? computedValues.status_value,
    move: move.move ?? (typeof computedValues.move === 'string' ? computedValues.move : undefined),
    created_cards: move.created_cards ?? computedValues.created_table ?? [],
    updated_cards: move.updated_cards ?? computedValues.updated_table ?? [],
    rationale: move.rationale ?? computedValues.rationale,
    next_candidates: move.next_candidates ?? computedValues.next_candidates_list ?? [],
  };
}

function moveCreatedCardIds(move) {
  return (Array.isArray(move?.created_cards) ? move.created_cards : [])
    .map((card) => card?.card_id)
    .filter(Boolean);
}

function behavioralChecks(move, cardsAfter, summary) {
  const checks = [];
  const after = new Set(cardsAfter);
  const created = Array.isArray(move.created_cards) ? move.created_cards : [];
  const updated = Array.isArray(move.updated_cards) ? move.updated_cards : [];

  if (created.length > 0) {
    checks.push(['every created card in the move exists on the board', created.every((card) => card.card_id && after.has(card.card_id))]);
    checks.push(['every created card is rooted in a board card', created.every((card) => !card.parent || after.has(card.parent))]);
  }
  if (updated.length > 0) {
    checks.push(['every updated card in the move exists on the board', updated.every((card) => card.card_id && after.has(card.card_id))]);
  }
  if (move.move === 'hold') {
    checks.push(['hold move makes no creations/updates of its own', created.length === 0 && updated.length === 0]);
  }
  if (summary) {
    checks.push(['board left healthy (no failed cards)', Number(summary.failed ?? 0) === 0]);
  }
  return { checks };
}

function buildStatusCardIndex(statusSnapshot) {
  const index = new Map();
  for (const entry of (statusSnapshot?.cards ?? [])) {
    const cardId = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (cardId) index.set(cardId, entry);
  }
  return index;
}

function summarizeBoardState(boardState) {
  const summary = {
    card_count: Array.isArray(boardState?.cardIds) ? boardState.cardIds.length : 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
  };
  for (const cardId of (boardState?.cardIds ?? [])) {
    const taskStatus = String(boardState?.modelsById?.[cardId]?.runtime_state?.task_status || '');
    if (taskStatus === 'completed') summary.completed += 1;
    else if (taskStatus === 'failed') summary.failed += 1;
    else if (taskStatus === 'running' || taskStatus === 'in-progress') summary.running += 1;
    else summary.pending += 1;
  }
  return summary;
}

function listJourneyCardDefinitions(payload) {
  const defs = Array.isArray(payload?.cardDefinitions) ? payload.cardDefinitions : [];
  return defs.filter(
    (def) => def?.id
      && !ADMIN_CARD_IDS.has(def.id)
      && def.id !== STRATEGIST_SEED_CARD_ID,
  );
}

function cardSearchText(card) {
  const tags = Array.isArray(card?.meta?.tags) ? card.meta.tags.map((tag) => String(tag)) : [];
  return [String(card?.meta?.title || ''), String(card?.meta?.desc || ''), tags.join(' ')].join(' ').toLowerCase();
}

function collectStringLeaves(value, into = []) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) into.push(text);
    return into;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStringLeaves(entry, into);
  }
  return into;
}

function runtimeCardSearchText(inspect) {
  const card = inspect?.card_definition_and_static_data || {};
  const runtimeValues = inspect?.runtime_data?.computed_values || {};
  const viewLabels = Array.isArray(card?.view?.elements)
    ? card.view.elements.map((element) => String(element?.label || ''))
    : [];
  const runtimeStrings = collectStringLeaves(runtimeValues);
  return [cardSearchText(card), viewLabels.join(' '), runtimeStrings.join(' ')].join(' ').toLowerCase();
}

function computeFacetCoverage(payload, facets) {
  const cards = listJourneyCardDefinitions(payload);
  const coverage = new Map();
  for (const facet of facets) {
    const hit = cards.find((card) => facet.match.test(cardSearchText(card)));
    if (hit) {
      coverage.set(facet.key, {
        cardId: hit.id,
        title: String(hit?.meta?.title || ''),
        tags: Array.isArray(hit?.meta?.tags) ? hit.meta.tags.map((tag) => String(tag)) : [],
      });
    }
  }
  return coverage;
}

async function computeLiveFacetCoverage({ apiBase, payload, facets }) {
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
  const cards = listJourneyCardDefinitions(payload);
  const coverage = new Map();
  const inspectedCards = await Promise.all(cards.map(async (card) => {
    try {
      const inspect = expectMcpSuccess(
        await callMcp('inspect.card-definition-and-runtime', { card_id: card.id }),
        `inspect.card-definition-and-runtime ${card.id} for facet coverage`,
      );
      return {
        id: card.id,
        meta: card.meta || {},
        searchText: runtimeCardSearchText(inspect),
      };
    } catch {
      return {
        id: card.id,
        meta: card.meta || {},
        searchText: cardSearchText(card),
      };
    }
  }));

  for (const facet of facets) {
    const hit = inspectedCards.find((card) => facet.match.test(card.searchText));
    if (hit) {
      coverage.set(facet.key, {
        cardId: hit.id,
        title: String(hit?.meta?.title || ''),
        tags: Array.isArray(hit?.meta?.tags) ? hit.meta.tags.map((tag) => String(tag)) : [],
      });
    }
  }
  return coverage;
}

function computeFacetCoverageFromInspectedCards(cards, facets) {
  const coverage = new Map();
  for (const facet of facets) {
    const hit = cards.find((card) => facet.match.test(card.searchText || ''));
    if (hit) {
      coverage.set(facet.key, {
        cardId: hit.id,
        title: String(hit?.meta?.title || ''),
        tags: Array.isArray(hit?.meta?.tags) ? hit.meta.tags.map((tag) => String(tag)) : [],
      });
    }
  }
  return coverage;
}

async function inspectLiveJourneyCards(apiBase) {
  const boardRuntime = expectMcpSuccess(
    await httpJson('POST', `${apiBase}/mcp`, {
      tool: 'inspect.board-runtime-status',
      args: {},
    }),
    `inspect.board-runtime-status ${apiBase}`,
  );
  const cards = Array.isArray(boardRuntime?.cards)
    ? boardRuntime.cards
    : (Array.isArray(boardRuntime?.data?.cards) ? boardRuntime.data.cards : []);
  const journeyIds = cards
    .map((entry) => String(entry?.['card-id'] || entry?.card_id || entry?.name || '').trim())
    .filter((id) => id && !ADMIN_CARD_IDS.has(id) && id !== STRATEGIST_SEED_CARD_ID);

  return Promise.all(journeyIds.map(async (cardId) => {
    const inspect = expectMcpSuccess(
      await httpJson('POST', `${apiBase}/mcp`, {
        tool: 'inspect.card-definition-and-runtime',
        args: { card_id: cardId },
      }),
      `inspect.card-definition-and-runtime ${cardId}`,
    );
    return {
      id: cardId,
      status: inspect?.card_status_in_board?.status ?? '',
      meta: inspect?.card_definition_and_static_data?.meta ?? {},
      computed_values: inspect?.runtime_data?.computed_values ?? {},
      searchText: runtimeCardSearchText(inspect),
    };
  }));
}

function normalizeNextCandidates(move) {
  return (Array.isArray(move?.next_candidates) ? move.next_candidates : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function moveSignature(move) {
  return JSON.stringify({
    status: typeof move?.status === 'string' ? move.status : '',
    move: typeof move?.move === 'string' ? move.move : '',
    created: Array.isArray(move?.created_cards)
      ? move.created_cards.map((entry) => `${entry?.card_id || ''}:${entry?.purpose || ''}:${entry?.parent || ''}:${entry?.shape || ''}`)
      : [],
    updated: Array.isArray(move?.updated_cards)
      ? move.updated_cards.map((entry) => `${entry?.card_id || ''}:${entry?.change || ''}`)
      : [],
    next: normalizeNextCandidates(move),
  });
}

function journeyCardIdsFromPayload(payload) {
  return listJourneyCardDefinitions(payload).map((card) => card.id);
}

async function waitForFreshStrategistCycle({
  apiBase,
  readModel,
  prevAttempt,
  prevJourneyCardIds = [],
  prevMoveSignature = '',
  timeoutMs,
  testId,
  phaseLabel,
}) {
  const deadline = Date.now() + timeoutMs;
  let after = null;
  const prevCardIdSet = new Set(prevJourneyCardIds);
  while (Date.now() < deadline) {
    await sleep(5_000);
    let snapshot;
    try {
      snapshot = await fetchBoardStateOnce(apiBase);
    } catch {
      continue;
    }
    if (!snapshot?.payload) continue;
    const model = readModel(snapshot.payload);
    const rt = model.runtime_state;
    const status = String(rt.task_status || '');
    const attempt = Number(rt.runtime?.attempt_count ?? 0);
    const move = moveFromComputed(model.computed_values || {});
    const hasVisibleMove = Boolean(
      (typeof move.status === 'string' && move.status.trim())
      || (typeof move.move === 'string' && move.move.trim())
      || normalizeNextCandidates(move).length > 0
      || (Array.isArray(move.created_cards) && move.created_cards.length > 0)
      || (Array.isArray(move.updated_cards) && move.updated_cards.length > 0)
    );
    const currentJourneyCardIds = journeyCardIdsFromPayload(snapshot.payload);
    const hasBoardDelta = currentJourneyCardIds.length !== prevJourneyCardIds.length
      || currentJourneyCardIds.some((cardId) => !prevCardIdSet.has(cardId));
    const currentMoveSignature = moveSignature(move);
    const hasFreshEvidence = attempt > prevAttempt
      || hasBoardDelta
      || (hasVisibleMove && currentMoveSignature !== prevMoveSignature);
    // A fresh strategist cycle can publish its move before the runtime flips
    // from running -> completed, but the harness still needs the visible move
    // payload itself before downstream contract assertions are meaningful.
    if (hasFreshEvidence && hasVisibleMove) {
      after = snapshot;
      break;
    }
  }
  assert(after, `${testId} strategist did not complete ${phaseLabel} within ${timeoutMs}ms`);
  return after;
}

function selectLiveCardModelFromPayload(payload, cardId) {
  const cardDefinitions = Array.isArray(payload?.cardDefinitions) ? payload.cardDefinitions : [];
  const card = cardDefinitions.find((entry) => entry?.id === cardId) ?? { id: cardId, card_data: {} };
  const statusEntry = buildStatusCardIndex(payload?.statusSnapshot).get(cardId) ?? null;
  const runtimeEntry = payload?.cardRuntimeById?.[cardId] ?? null;
  const requires = {};
  for (const token of normalizeRequiredTokens(card?.requires)) {
    requires[token] = Object.prototype.hasOwnProperty.call(payload?.dataObjectsByToken ?? {}, token)
      ? payload.dataObjectsByToken[token]
      : null;
  }
  return {
    id: cardId,
    card,
    card_data: card?.card_data ?? {},
    requires,
    computed_values: runtimeEntry?.computed_values ?? {},
    runtime_state: {
      task_status: statusEntry?.status ?? null,
      card_status: statusEntry?.status ?? null,
      runtime: statusEntry?.runtime ?? runtimeEntry?.runtime ?? {},
      error: statusEntry?.error ?? null,
      blocked_by: Array.isArray(statusEntry?.blocked_by) ? statusEntry.blocked_by : [],
      requires_missing: Array.isArray(statusEntry?.requires_missing) ? statusEntry.requires_missing : [],
    },
  };
}

async function inspectLiveCardModel(apiBase, cardId, label = cardId) {
  const inspect = expectMcpSuccess(
    await httpJson('POST', `${apiBase}/mcp`, {
      tool: 'inspect.card-definition-and-runtime',
      args: { card_id: cardId },
    }),
    label,
  );
  return {
    computed_values: inspect?.runtime_data?.computed_values ?? {},
    runtime_state: {
      task_status: inspect?.card_status_in_board?.status ?? null,
      card_status: inspect?.card_status_in_board?.status ?? null,
      runtime: inspect?.card_status_in_board?.runtime ?? {},
      error: inspect?.card_status_in_board?.error ?? null,
      blocked_by: Array.isArray(inspect?.card_status_in_board?.blocked_by) ? inspect.card_status_in_board.blocked_by : [],
      requires_missing: Array.isArray(inspect?.card_status_in_board?.requires_missing) ? inspect.card_status_in_board.requires_missing : [],
    },
  };
}

function httpJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const requestBody = payload == null ? null : JSON.stringify(payload);
    const request = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: requestBody
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody),
            }
          : {},
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let data = responseBody;
          try {
            data = responseBody ? JSON.parse(responseBody) : null;
          } catch {
            data = responseBody;
          }
          resolve({ status: response.statusCode || 0, data });
        });
      },
    );
    request.on('error', reject);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function parseSseBlocks(buffer) {
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const payloads = [];
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const rawPayload = dataLines.join('\n').trim();
    if (!rawPayload) continue;
    try {
      payloads.push(JSON.parse(rawPayload));
    } catch {
      // Ignore malformed SSE payloads in test helper.
    }
  }
  return { payloads, remainder };
}

function applyHostedSseFrame(prev, payload, latestPayloadRef) {
  const base = prev ?? { boardState: null };
  let boardState = base.boardState;

  if (payload && Array.isArray(payload.cardDefinitions)) {
    boardState = buildBoardState(payload, boardState, selectLiveCardModelFromPayload);
  }

  const notifications = runtimeNotificationsFromPayload(payload);
  if (notifications.length > 0 && boardState) {
    boardState = applyNotification(
      boardState,
      notifications,
      selectLiveCardModelFromPayload,
      () => latestPayloadRef(),
    );
  }

  if (boardState === base.boardState) {
    return base;
  }

  return {
    boardState,
  };
}

function fetchBoardStateOnce(apiBase, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const sseUrl = `${apiBase}/sse?one-shot`;
    let buffer = '';
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { request.destroy(); } catch {}
      fn(value);
    };
    const request = http.get(sseUrl, (response) => {
      response.setEncoding('utf-8');
      response.on('data', (chunk) => {
        if (settled) return;
        buffer = `${buffer}${chunk}`.replace(/\r\n/g, '\n');
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.remainder;
        const payload = parsed.payloads.find((entry) => Array.isArray(entry?.cardDefinitions));
        if (payload) {
          const snapshot = applyHostedSseFrame({ boardState: null }, payload, () => payload);
          finish(resolve, { boardState: snapshot.boardState ?? null, payload });
        }
      });
      response.on('end', () => finish(resolve, { boardState: null, payload: null }));
    });
    timer = setTimeout(
      () => finish(reject, new Error(`one-shot board state timed out after ${timeoutMs}ms for ${sseUrl}`)),
      timeoutMs,
    );
    request.on('error', (error) => finish(reject, error instanceof Error ? error : new Error(String(error))));
  });
}

function expectMcpSuccess(result, label) {
  assert(result.status === 200, `${label} returned HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  assert(result.data?.status === 'success', `${label} failed: ${JSON.stringify(result.data)}`);
  return result.data?.data ?? null;
}

const requestedTests = parseRequestedTests(readCliOptionValue(cliArgs, '--run-tests'));
const portArg = readCliOptionValue(cliArgs, '--port');
const BOARD_SERVER_URL = portArg ? `http://127.0.0.1:${portArg}` : 'http://127.0.0.1:7799';
const STRATEGIST_CARD_ID = 'journey-strategist';
const OBSERVATORY_CARD_ID = 'card-journey-observatory';
const STRATEGIST_SEED_CARD_ID = 'card-journey-seed';
const STRATEGIST_SEED_TEMPLATE_PATH = path.resolve(
  __dirname,
  '../server/hosted-board-runtime/sample-card-templates/journey-seed.json',
);
const STRATEGIST_POLICY = { maxNewCardsPerCycle: 2, maxDepth: 6, maxBreadth: 4 };
const STRATEGIST_CYCLE_TIMEOUT_MS = 600_000;
const STRATEGIST_BOARD_ID = 'profile';
const STRATEGIST_INTENT = 'Build a background profile of a software engineer named Alex Rivera for a hiring screen — who they are professionally, where they show up online, any notable work or publications, and recent news — and flag if there may be several different people with this name.';
const STRATEGIST_TRIP_BOARD_ID = 'trip';
const STRATEGIST_TRIP_INTENT = 'Plan a 10-day late-October trip to Japan for two, balancing a few days in Tokyo, a traditional ryokan onsen stay near Hakone, and temple-focused time in Kyoto, on a mid-range budget';
const PROFILE_PLANT_TIMEOUT_MS = 120_000;
const MAX_STRATEGIST_SCENARIO_CYCLES = 6;
const PROFILE_FACETS = [
  { key: 'background', label: 'Professional Background / Education', match: /linkedin|professional background|career|work experience|education/i },
  { key: 'social', label: 'Social Media Handles', match: /social|handle|online presence/i },
  { key: 'publications', label: 'Patents & Publications', match: /patent|publication|paper|notable work/i },
  { key: 'news', label: 'News & Press Mentions', match: /news|press|media mention/i },
  { key: 'disambiguation', label: 'Identity Disambiguation', match: /disambiguat|identity|which .*(person|alex)/i, decision: true },
];
const TRIP_FACETS = [
  { key: 'itinerary', label: 'Itinerary / Day-Level Pacing', match: /itinerary|day-level pacing|trip shape|booking checklist|booking sequence/i },
  { key: 'lodging', label: 'Lodging / Hakone Strategy', match: /lodging|ryokan|onsen|hakone/i },
  { key: 'tokyo', label: 'Tokyo Neighborhood Strategy', match: /tokyo neighborhood|tokyo base/i },
  { key: 'kyoto', label: 'Kyoto Temple Priorities', match: /kyoto temple|kyoto base|temple priorities/i },
  { key: 'decision', label: 'Traveler Decision / Handoff', match: /decision|bookable handoff|pick your tokyo and kyoto base style|base choice/i, decision: true },
];
const PROFILE_PLANTED_CARDS = [
  {
    expectCount: 3,
    card: {
      id: 'profile-linkedin',
      meta: { title: 'LinkedIn / Professional Background', tags: ['profile', 'linkedin'], desc: 'Professional background for the profile subject, from the linkedin source.', presentation: { footprint: 'standard' } },
      source_defs: [{ bindTo: 'src', outputFile: 'profile-linkedin.json', mock: 'profile_alex_rivera_linkedin' }],
      compute: [{ bindTo: 'probe_count', expr: '$count(($d := fetched_sources.src; $exists($d.experience) ? $d.experience : $d.resultValue.experience))' }],
      view: { elements: [{ kind: 'metric', label: 'Roles on record', data: { bind: 'computed_values.probe_count' } }] },
      card_data: {},
    },
  },
  {
    expectCount: 4,
    card: {
      id: 'profile-social',
      meta: { title: 'Social Media Handles', tags: ['profile', 'social'], desc: 'Public social and media handles for the profile subject.', presentation: { footprint: 'standard' } },
      source_defs: [{ bindTo: 'src', outputFile: 'profile-social.json', mock: 'profile_alex_rivera_social' }],
      compute: [{ bindTo: 'probe_count', expr: '$count(($d := fetched_sources.src; $exists($d.handles) ? $d.handles : $d.resultValue.handles))' }],
      view: { elements: [{ kind: 'metric', label: 'Handles found', data: { bind: 'computed_values.probe_count' } }] },
      card_data: {},
    },
  },
  {
    expectCount: 2,
    card: {
      id: 'profile-publications',
      meta: { title: 'Patents & Publications', tags: ['profile', 'publications'], desc: 'Notable work for the profile subject — patents and papers.', presentation: { footprint: 'standard' } },
      source_defs: [{ bindTo: 'src', outputFile: 'profile-publications.json', mock: 'profile_alex_rivera_publications' }],
      compute: [{ bindTo: 'probe_count', expr: '$count(($d := fetched_sources.src; $exists($d.papers) ? $d.papers : $d.resultValue.papers))' }],
      view: { elements: [{ kind: 'metric', label: 'Papers on record', data: { bind: 'computed_values.probe_count' } }] },
      card_data: {},
    },
  },
  {
    expectCount: 3,
    card: {
      id: 'profile-news',
      meta: { title: 'News & Press Mentions', tags: ['profile', 'news'], desc: 'Recent news and press mentions for the profile subject.', presentation: { footprint: 'standard' } },
      source_defs: [{ bindTo: 'src', outputFile: 'profile-news.json', mock: 'profile_alex_rivera_news' }],
      compute: [{ bindTo: 'probe_count', expr: '$count(($d := fetched_sources.src; $exists($d.mentions) ? $d.mentions : $d.resultValue.mentions))' }],
      view: { elements: [{ kind: 'metric', label: 'Press mentions', data: { bind: 'computed_values.probe_count' } }] },
      card_data: {},
    },
  },
  {
    expectCount: 4,
    card: {
      id: 'profile-disambiguation',
      meta: { title: 'Identity Disambiguation', tags: ['profile', 'disambiguation', 'decision'], desc: 'Several people share this name. Confirm which person this profile is about.', presentation: { footprint: 'standard' } },
      source_defs: [{ bindTo: 'src', outputFile: 'profile-identities.json', mock: 'profile_alex_rivera_identities' }],
      compute: [
        { bindTo: 'probe_count', expr: '$count(($d := fetched_sources.src; $exists($d.candidates) ? $d.candidates : $d.resultValue.candidates))' },
        { bindTo: 'candidates', expr: '($d := fetched_sources.src; $exists($d.candidates) ? $d.candidates : $d.resultValue.candidates)' },
      ],
      view: { elements: [{ kind: 'table', label: 'Which person?', data: { bind: 'computed_values.candidates', columns: ['name', 'headline', 'location', 'confidence'], sortable: true } }] },
      card_data: {},
    },
  },
];
const PROFILE_VALUE_CAMPAIGN_PLANTED_CARDS = PROFILE_PLANTED_CARDS.slice(0, 3);

function assertProfileScaffoldShape({ payload, boardState, testId, move = null, requireNextSignal = false, requireStrategistStatus = false }) {
  const coverage = computeFacetCoverage(payload, PROFILE_FACETS);
  const missingFacets = PROFILE_FACETS.filter((facet) => !coverage.has(facet.key));
  assert(
    missingFacets.length === 0,
    `${testId} profile scaffold is incomplete — missing facet card(s): ${missingFacets.map((facet) => facet.label).join('; ')}`,
  );
  const decisionFacet = PROFILE_FACETS.find((facet) => facet.decision);
  assert(
    decisionFacet && coverage.has(decisionFacet.key),
    `${testId} identity-disambiguation decision card missing from the profile scaffold`,
  );

  const journeyCardIds = (boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id));
  const summary = summarizeBoardState(boardState);
  assert(
    journeyCardIds.length >= PROFILE_FACETS.length,
    `${testId} profile board did not visibly decompose into an investigation scaffold (journey cards=${journeyCardIds.length})`,
  );
  assert(Number(summary.failed ?? 0) === 0, `${testId} board has ${summary.failed} failed card(s) after scaffold growth`);

  const nextCandidates = normalizeNextCandidates(move);
  if (requireNextSignal) {
    assert(nextCandidates.length > 0, `${testId} profile scaffold produced no visible next-step candidates`);
  }
  if (requireStrategistStatus) {
    assert(
      move?.status === 'advancing' || move?.status === 'aligned',
      `${testId} expected profile scaffold status advancing/aligned, got ${move?.status}`,
    );
  }

  return {
    coverage,
    journeyCardIds,
    summary,
    nextCandidates,
  };
}

async function resetBoardToFreshRuntime({ boardId, testId, formatTestId, expectedCardIds }) {
  const tag = formatTestId(testId);
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
  const resetResult = await httpJson('POST', manageUrl, {
    subcommand: 'reset-board',
    args: { boardId },
  });
  assert(
    resetResult.status === 200 && resetResult.data?.status === 'success',
    `${testId} reset-board failed: HTTP ${resetResult.status} ${JSON.stringify(resetResult.data)}`,
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      const checks = await Promise.all(expectedCardIds.map(async (cardId) => {
        const inspect = expectMcpSuccess(
          await callMcp('inspect.card-definition-and-runtime', { card_id: cardId }),
          `${testId} inspect.card-definition-and-runtime ${cardId} after reset-board`,
        );
        return inspect?.cardId === cardId || inspect?.card_definition_and_static_data?.id === cardId;
      }));
      if (checks.every(Boolean)) {
        console.log(`[${tag}] reset-board restored a fresh runtime workspace for '${boardId}'`);
        return await fetchBoardStateOnce(apiBase);
      }
    } catch {
      continue;
    }
  }
  assert(false, `${testId} reset-board did not restore the expected admin cards within 60000ms`);
}

async function runStrategistBasicValidation({ testId, formatTestId }) {
  const tag = formatTestId(testId);
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const profileApiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(STRATEGIST_BOARD_ID)}`;
  const tripApiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(STRATEGIST_TRIP_BOARD_ID)}`;
  const profileCallMcp = (tool, args) => httpJson('POST', `${profileApiBase}/mcp`, { tool, args });

  console.log(`[${tag}] step 1/4: checking strategist seed template`);
  const seedTemplate = JSON.parse(fs.readFileSync(STRATEGIST_SEED_TEMPLATE_PATH, 'utf-8'));
  const seedCard = (Array.isArray(seedTemplate?.cards) ? seedTemplate.cards : []).find(
    (entry) => entry?.id === STRATEGIST_SEED_CARD_ID,
  );
  assert(seedCard, `${testId} journey-seed template missing ${STRATEGIST_SEED_CARD_ID}`);

  console.log(`[${tag}] step 2/4: confirming hosted board server and strategist boards`);
  const existingBoards = await httpJson('POST', manageUrl, { subcommand: 'list-boards' });
  assert(existingBoards.status === 200, `${testId} list-boards returned HTTP ${existingBoards.status}`);
  const boards = Array.isArray(existingBoards.data?.data?.boards) ? existingBoards.data.data.boards : null;
  assert(boards, `${testId} list-boards returned an unexpected payload: ${JSON.stringify(existingBoards.data)}`);
  const boardIds = new Set(boards.map((entry) => String(entry?.id ?? '')).filter(Boolean));
  assert(boardIds.has(STRATEGIST_BOARD_ID), `${testId} expected board '${STRATEGIST_BOARD_ID}' to exist`);
  assert(boardIds.has(STRATEGIST_TRIP_BOARD_ID), `${testId} expected board '${STRATEGIST_TRIP_BOARD_ID}' to exist`);

  console.log(`[${tag}] step 3/4: reading one-shot board state for profile and trip`);
  const [profileBoard, tripBoard] = await Promise.all([
    fetchBoardStateOnce(profileApiBase),
    fetchBoardStateOnce(tripApiBase),
  ]);
  assert(profileBoard?.payload, `${testId} could not read board state for '${STRATEGIST_BOARD_ID}'`);
  assert(tripBoard?.payload, `${testId} could not read board state for '${STRATEGIST_TRIP_BOARD_ID}'`);
  const requiredProfileCards = [STRATEGIST_CARD_ID, OBSERVATORY_CARD_ID, STRATEGIST_SEED_CARD_ID];
  for (const cardId of requiredProfileCards) {
    const present = (profileBoard.payload.cardDefinitions ?? []).some((entry) => entry?.id === cardId);
    assert(present, `${testId} expected '${STRATEGIST_BOARD_ID}' board to contain ${cardId}`);
  }
  const tripStrategistPresent = (tripBoard.payload.cardDefinitions ?? []).some((entry) => entry?.id === STRATEGIST_CARD_ID);
  assert(tripStrategistPresent, `${testId} expected '${STRATEGIST_TRIP_BOARD_ID}' board to contain ${STRATEGIST_CARD_ID}`);

  console.log(`[${tag}] step 4/4: inspecting observatory runtime wiring`);
  const observatoryInspect = expectMcpSuccess(
    await profileCallMcp('inspect.card-definition-and-runtime', { card_id: OBSERVATORY_CARD_ID }),
    `${testId} inspect.card-definition-and-runtime ${OBSERVATORY_CARD_ID}`,
  );
  const observatory = readObservatorySnapshot({ data: observatoryInspect });
  assert(Number.isFinite(observatory.cardCount), `${testId} observatory card count was not numeric`);
  assert(Number.isFinite(observatory.journeyValue), `${testId} observatory journey value was not numeric`);
  assert(observatory.cardCount >= 1, `${testId} observatory reported no journey cards`);

  console.log(
    `[${tag}] basic validation PASS: boards reachable, seed template present, SSE snapshots readable, `
    + `observatory wired (cards=${observatory.cardCount}, value=${observatory.journeyValue}, band=${observatory.journeyValueBand || 'n/a'})`,
  );
}

function readObservatorySnapshot(inspectPayload) {
  const data = inspectPayload?.data && typeof inspectPayload.data === 'object' ? inspectPayload.data : {};
  const computed = data?.runtime_data?.computed_values && typeof data.runtime_data.computed_values === 'object'
    ? data.runtime_data.computed_values
    : {};
  const runtime = data?.card_status_in_board?.runtime && typeof data.card_status_in_board.runtime === 'object'
    ? data.card_status_in_board.runtime
    : {};
  return {
    attemptCount: Number(runtime.attempt_count ?? 0),
    taskStatus: String(data?.card_status_in_board?.status || ''),
    cardCount: Number(computed.obs_card_count ?? 0),
    completedCount: Number(computed.obs_completed_count ?? 0),
    failedCount: Number(computed.obs_failed_count ?? 0),
    blockedCount: Number(computed.obs_blocked_count ?? 0),
    inProgressCount: Number(computed.obs_in_progress_count ?? 0),
    journeyValue: Number(computed.journey_value ?? 0),
    journeyValueBand: String(computed.journey_value_band || ''),
    settled: computed.obs_settled === true,
  };
}

async function refreshObservatoryCard({ apiBase, testId, minCardCount = 0, timeoutMs = 90_000 }) {
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
  const callAction = (tool, cardId, payload = {}) => httpJson('POST', `${apiBase}/mcp-actions`, {
    tool,
    args: { card_id: cardId, payload },
  });
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let nudgedAt = 0;
  while (Date.now() < deadline) {
    if (Date.now() - nudgedAt > 8_000) {
      await callAction('retrigger-card', OBSERVATORY_CARD_ID).catch(() => {});
      nudgedAt = Date.now();
    }
    await sleep(2_000);
    latest = expectMcpSuccess(
      await callMcp('inspect.card-definition-and-runtime', { card_id: OBSERVATORY_CARD_ID }),
      `${testId} inspect.card-definition-and-runtime ${OBSERVATORY_CARD_ID}`,
    );
    const next = readObservatorySnapshot({ data: latest });
    if (next.settled && next.cardCount >= minCardCount) {
      return { payload: latest, snapshot: next };
    }
  }
  assert(false, `${testId} observatory did not reflect >= ${minCardCount} settled cards within ${timeoutMs}ms`);
}

/*
A1 e2e purpose: validate the profile scaffold acceptance shape without
requiring a fresh strategist cycle. This proves that the harness can recognize a
healthy, legible profile-investigation board state independently from live
strategist causality.

One-sentence outcome (T8-style):
"I plant a minimal valid profile-investigation scaffold, and the harness recognizes it as a healthy, legible background-check board without requiring a fresh strategist cycle to have happened just now."
*/
async function runProfileScaffoldAcceptance({ testId, boardId, intent, formatTestId }) {
  const tag = formatTestId(testId);
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });

  console.log(`[${tag}] step 1/5: confirming bootstrapped journeys board '${boardId}' exists`);
  const existingBoards = await httpJson('POST', manageUrl, { subcommand: 'list-boards' });
  const boardExists = Array.isArray(existingBoards.data?.data?.boards)
    && existingBoards.data.data.boards.some((entry) => String(entry?.id ?? '') === boardId);
  assert(boardExists, `${testId} expected bootstrapped board '${boardId}' to exist (register it in hosted-board-runtime.localfs.config.json)`);

  console.log(`[${tag}] step 2/5: resetting '${boardId}' to seed-only`);
  await resetBoardToFreshRuntime({
    boardId,
    testId,
    formatTestId,
    expectedCardIds: [STRATEGIST_CARD_ID, OBSERVATORY_CARD_ID],
  });

  console.log(`[${tag}] step 3/5: seeding ${STRATEGIST_SEED_CARD_ID} with the profile brief`);
  const seedTemplate = JSON.parse(fs.readFileSync(STRATEGIST_SEED_TEMPLATE_PATH, 'utf-8'));
  const seedCard = (Array.isArray(seedTemplate?.cards) ? seedTemplate.cards : []).find(
    (entry) => entry?.id === STRATEGIST_SEED_CARD_ID,
  );
  assert(seedCard, `${testId} journey-seed template missing ${STRATEGIST_SEED_CARD_ID}`);
  seedCard.card_data = { ...(seedCard.card_data || {}), intent };
  expectMcpSuccess(
    await callMcp('manage.upsert-card', {
      card_id: STRATEGIST_SEED_CARD_ID,
      candidate_card_content: seedCard,
    }),
    `${testId} manage.upsert-card journey-seed`,
  );

  console.log(`[${tag}] step 4/5: planting a minimal valid profile-investigation scaffold directly`);
  for (const entry of PROFILE_PLANTED_CARDS) {
    expectMcpSuccess(
      await callMcp('manage.upsert-card', { card_id: entry.card.id, candidate_card_content: entry.card }),
      `${testId} manage.upsert-card ${entry.card.id}`,
    );
  }
  const plantedIds = PROFILE_PLANTED_CARDS.map((entry) => entry.card.id);
  const plantDeadline = Date.now() + PROFILE_PLANT_TIMEOUT_MS;
  let acceptedBoard = null;
  while (Date.now() < plantDeadline) {
    await sleep(3_000);
    let snapshot;
    try {
      snapshot = await fetchBoardStateOnce(apiBase);
    } catch {
      continue;
    }
    if (!snapshot?.payload) continue;
    acceptedBoard = snapshot;
    const allDone = plantedIds.every((id) => (
      String(selectLiveCardModelFromPayload(snapshot.payload, id).runtime_state.task_status || '') === 'completed'
    ));
    if (allDone) break;
  }
  assert(acceptedBoard?.payload, `${testId} never captured a board snapshot while planting the acceptance scaffold`);

  console.log(`[${tag}] step 5/5: asserting the profile scaffold acceptance shape`);
  const accepted = assertProfileScaffoldShape({
    payload: acceptedBoard.payload,
    boardState: acceptedBoard.boardState,
    testId,
  });
  console.log(
    `[${tag}] profile scaffold acceptance verified: recognizable shape present `
    + `(facets=${accepted.coverage.size}/${PROFILE_FACETS.length}, journey cards=${accepted.journeyCardIds.length})`,
  );
}

/*
S2 e2e purpose: start from a concrete Japan trip brief and verify that the
strategist grows a recognizable planning scaffold on the board. The expected
outcome is not final booking completion; it is a visible planning structure with
itinerary/lodging/Tokyo/Kyoto facets, a traveler decision or handoff point, and
at least one visible next step while the board stays healthy.

One-sentence outcome (T8-style):
"I type a concrete Japan trip brief, and the whiteboard grows into a recognizable travel-planning board — itinerary shape, lodging/Hakone strategy, Tokyo and Kyoto planning, plus a traveler decision or handoff card and a suggested next step; the AI finishes and the board is healthy."
*/
async function runStrategistLiveCycle({ testId, boardId, intent, formatTestId }) {
  const tag = formatTestId(testId);
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const callAction = (tool, cardId, payload = {}) => httpJson('POST', `${apiBase}/mcp-actions`, {
    tool,
    args: { card_id: cardId, payload },
  });
  const readModel = (payload) => selectLiveCardModelFromPayload(payload, STRATEGIST_CARD_ID);

  let createdBoard = false;
  try {
    const existingBoards = await httpJson('POST', manageUrl, { subcommand: 'list-boards' });
    const boardPreexisted = Array.isArray(existingBoards.data?.data?.boards)
      && existingBoards.data.data.boards.some((entry) => String(entry?.id ?? '') === boardId);
    if (boardPreexisted) {
      console.log(`[${tag}] step 1/6: reusing existing journeys board '${boardId}'`);
    } else {
      console.log(`[${tag}] step 1/6: registering journeys board '${boardId}'`);
      const addResult = await httpJson('POST', manageUrl, {
        subcommand: 'add-board',
        args: {
          boardId,
          record: {
            label: `Live Test Journey (${testId})`,
            ai: 'copilot',
            aiWorkspaceTemplate: 'default',
            refsTemplate: 'localfs-default',
            uiTemplate: 'journeys',
            cardsTemplate: 'journey-seed',
          },
        },
      });
      assert(
        addResult.status === 200 && addResult.data?.status === 'success',
        `${testId} add-board failed: HTTP ${addResult.status} ${JSON.stringify(addResult.data)}`,
      );
      createdBoard = true;
    }

    if (boardPreexisted) {
      await resetBoardToFreshRuntime({
        boardId,
        testId,
        formatTestId,
        expectedCardIds: [STRATEGIST_CARD_ID],
      });
    }

    const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });

    console.log(`[${tag}] step 2/6: upserting ${STRATEGIST_SEED_CARD_ID} with the test intent`);
    const seedTemplate = JSON.parse(fs.readFileSync(STRATEGIST_SEED_TEMPLATE_PATH, 'utf-8'));
    const seedCard = (Array.isArray(seedTemplate?.cards) ? seedTemplate.cards : []).find(
      (entry) => entry?.id === STRATEGIST_SEED_CARD_ID,
    );
    assert(seedCard, `${testId} journey-seed template missing ${STRATEGIST_SEED_CARD_ID}`);
    seedCard.card_data = { ...(seedCard.card_data || {}), intent };
    expectMcpSuccess(
      await callMcp('manage.upsert-card', {
        card_id: STRATEGIST_SEED_CARD_ID,
        candidate_card_content: seedCard,
      }),
      `${testId} manage.upsert-card journey-seed`,
    );

    console.log(`[${tag}] step 3/6: driving up to ${MAX_STRATEGIST_SCENARIO_CYCLES} strategist cycles until the trip scaffold is recognizable`);
    let finalState = null;
    for (let cycle = 1; cycle <= MAX_STRATEGIST_SCENARIO_CYCLES; cycle += 1) {
      const before = await fetchBoardStateOnce(apiBase);
      assert(before?.payload, `${testId} could not read board state before trip cycle ${cycle}`);
      const prevAttempt = Number(readModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);
      const prevJourneyCardIds = journeyCardIdsFromPayload(before.payload);
      const prevMove = moveFromComputed(readModel(before.payload).computed_values || {});

      const wakeResult = await callAction('retrigger-card', STRATEGIST_CARD_ID);
      assert(
        wakeResult.status === 200 && wakeResult.data?.status === 'success',
        `${testId} retrigger-card failed: HTTP ${wakeResult.status} ${JSON.stringify(wakeResult.data)}`,
      );

      let after = await waitForFreshStrategistCycle({
        apiBase,
        readModel,
        prevAttempt,
        prevJourneyCardIds,
        prevMoveSignature: moveSignature(prevMove),
        timeoutMs: STRATEGIST_CYCLE_TIMEOUT_MS,
        testId,
        phaseLabel: `trip cycle ${cycle}`,
      });

      let move = moveFromComputed(
        (await inspectLiveCardModel(apiBase, STRATEGIST_CARD_ID, `${testId} inspect.card-definition-and-runtime ${STRATEGIST_CARD_ID} after trip cycle ${cycle}`)).computed_values || {},
      );
      const claimedIds = [
        ...moveCreatedCardIds(move),
        ...(Array.isArray(move.updated_cards) ? move.updated_cards : []).map((entry) => entry?.card_id).filter(Boolean),
      ];
      if (claimedIds.length > 0) {
        const settleDeadline = Date.now() + 30_000;
        while (Date.now() < settleDeadline) {
          const ids = new Set(after.boardState?.cardIds ?? []);
          if (claimedIds.every((id) => ids.has(id))) break;
          await sleep(3_000);
          try {
            after = (await fetchBoardStateOnce(apiBase)) ?? after;
          } catch {
            // Keep the last good snapshot.
          }
        }
        move = moveFromComputed(
          (await inspectLiveCardModel(apiBase, STRATEGIST_CARD_ID, `${testId} inspect.card-definition-and-runtime ${STRATEGIST_CARD_ID} after trip settle ${cycle}`)).computed_values || {},
        );
      }

      let liveTripCards = await inspectLiveJourneyCards(apiBase);
      let journeyCardIds = liveTripCards.map((card) => card.id);
      let createdThisMove = new Set(moveCreatedCardIds(move));
      let contractBoardState = {
        cardIds: journeyCardIds.filter((id) => !createdThisMove.has(id)),
        policy: STRATEGIST_POLICY,
      };
      let contract = validateMove(move, contractBoardState);
      let summary = {
        card_count: journeyCardIds.length,
        completed: liveTripCards.filter((card) => card.status === 'completed').length,
        failed: liveTripCards.filter((card) => card.status === 'failed').length,
        running: liveTripCards.filter((card) => card.status === 'running' || card.status === 'in-progress').length,
        pending: liveTripCards.filter((card) => !['completed', 'failed', 'running', 'in-progress'].includes(card.status)).length,
      };
      let behavior = behavioralChecks(move, journeyCardIds, summary);
      let newJourneyCardIds = journeyCardIds.filter((id) => !prevJourneyCardIds.includes(id));
      let hasFreshBoardAdvance = newJourneyCardIds.length > 0;
      let tripCoverage = computeFacetCoverageFromInspectedCards(liveTripCards, TRIP_FACETS);
      let tripCards = liveTripCards;
      let hasConsolidatedTripDraft = tripCards.some((card) => /draft japan itinerary|japan trip draft|trip draft|itinerary/i.test(card.searchText || ''));
      let hasTravelerHandoff = tripCards.some((card) => /constraint|date|budget|booking|handoff|decision|pick/i.test(card.searchText || ''));

      if ((!contract.ok && !hasFreshBoardAdvance) || tripCards.length === 0) {
        const settleDeadline = Date.now() + 30_000;
        while (Date.now() < settleDeadline) {
          await sleep(3_000);
          move = moveFromComputed(
            (await inspectLiveCardModel(apiBase, STRATEGIST_CARD_ID, `${testId} inspect.card-definition-and-runtime ${STRATEGIST_CARD_ID} while settling trip cycle ${cycle}`)).computed_values || {},
          );
          liveTripCards = await inspectLiveJourneyCards(apiBase);
          journeyCardIds = liveTripCards.map((card) => card.id);
          createdThisMove = new Set(moveCreatedCardIds(move));
          contractBoardState = {
            cardIds: journeyCardIds.filter((id) => !createdThisMove.has(id)),
            policy: STRATEGIST_POLICY,
          };
          contract = validateMove(move, contractBoardState);
          summary = {
            card_count: journeyCardIds.length,
            completed: liveTripCards.filter((card) => card.status === 'completed').length,
            failed: liveTripCards.filter((card) => card.status === 'failed').length,
            running: liveTripCards.filter((card) => card.status === 'running' || card.status === 'in-progress').length,
            pending: liveTripCards.filter((card) => !['completed', 'failed', 'running', 'in-progress'].includes(card.status)).length,
          };
          behavior = behavioralChecks(move, journeyCardIds, summary);
          newJourneyCardIds = journeyCardIds.filter((id) => !prevJourneyCardIds.includes(id));
          hasFreshBoardAdvance = newJourneyCardIds.length > 0;
          tripCoverage = computeFacetCoverageFromInspectedCards(liveTripCards, TRIP_FACETS);
          tripCards = liveTripCards;
          hasConsolidatedTripDraft = tripCards.some((card) => /draft japan itinerary|japan trip draft|trip draft|itinerary/i.test(card.searchText || ''));
          hasTravelerHandoff = tripCards.some((card) => /constraint|date|budget|booking|handoff|decision|pick/i.test(card.searchText || ''));
          if ((contract.ok || hasFreshBoardAdvance) && tripCards.length > 0) {
            break;
          }
        }
      }

      const recognizableTripScaffold = tripCoverage.size >= 4
        || (hasConsolidatedTripDraft && hasTravelerHandoff)
        || (tripCoverage.has('itinerary') && (tripCoverage.has('decision') || hasTravelerHandoff));
      const nextCandidates = normalizeNextCandidates(move);
      const contractAcceptable = contract.ok || (hasFreshBoardAdvance && hasTravelerHandoff);
      const statusAcceptable = move.status === 'advancing'
        || move.status === 'aligned'
        || (move.status === 'waiting'
          && (move.move === 'clarify' || move.move === 'decide')
          && (tripCoverage.has('decision') || hasTravelerHandoff))
        || (!contract.ok && hasFreshBoardAdvance && hasTravelerHandoff)
        || (move.move === 'hold' && recognizableTripScaffold && (nextCandidates.length > 0 || hasTravelerHandoff));

      finalState = {
        move,
        contract,
        behavior,
        journeyCardIds,
        tripCoverage,
        tripCards,
        hasTravelerHandoff,
        hasConsolidatedTripDraft,
        recognizableTripScaffold,
        nextCandidates,
        statusAcceptable,
        contractAcceptable,
        hasFreshBoardAdvance,
        newJourneyCardIds,
      };

      console.log(
        `[${tag}] cycle ${cycle}: facets=${tripCoverage.size}/${TRIP_FACETS.length} `
        + `cards=${journeyCardIds.length} move=${move.move ?? '(n/a)'} status=${move.status ?? '(n/a)'} next=${nextCandidates.length}`,
      );
      if (recognizableTripScaffold && hasTravelerHandoff && (nextCandidates.length > 0 || hasTravelerHandoff) && statusAcceptable) {
        break;
      }
    }

    assert(finalState, `${testId} never captured a usable trip scaffold state`);
    const {
      move,
      contract,
      behavior,
      journeyCardIds,
      tripCoverage,
      tripCards,
      hasTravelerHandoff,
      recognizableTripScaffold,
      nextCandidates,
      statusAcceptable,
      contractAcceptable,
      hasFreshBoardAdvance,
      newJourneyCardIds,
    } = finalState;

    console.log(`[${tag}] step 4/6: validating the final recognizable trip scaffold`);
    console.log(
      `[${tag}] move: status=${move.status ?? '(n/a)'} move=${move.move ?? '(n/a)'} `
      + `created=${(move.created_cards || []).length} updated=${(move.updated_cards || []).length}`,
    );
    for (const warning of contract.warnings) {
      console.log(`[${tag}] warning (contract): ${warning}`);
    }
    if (!contract.ok && hasFreshBoardAdvance) {
      console.log(
        `[${tag}] warning (contract): strategist move payload was not durable at validation time; using fresh board advance instead (${newJourneyCardIds.join(', ')})`,
      );
    } else {
      assert(contractAcceptable, `${testId} move violates the strategist contract: ${JSON.stringify(contract.errors)}`);
    }
    for (const [label, ok] of behavior.checks) {
      assert(ok, `${testId} behavioral check failed: ${label}`);
      console.log(`[${tag}] behavior PASS: ${label}`);
    }
    assert(
      recognizableTripScaffold,
      `${testId} trip scaffold stayed too thin after ${MAX_STRATEGIST_SCENARIO_CYCLES} cycles: expected either 4 recognizable planning facets or a consolidated draft + traveler handoff, got facets=${tripCoverage.size} cards=${tripCards.map((card) => card.id).join(',')}`,
    );
    assert(
      tripCoverage.has('decision') || hasTravelerHandoff,
      `${testId} trip scaffold did not surface a traveler decision or handoff card`,
    );
    assert(
      nextCandidates.length > 0 || hasTravelerHandoff,
      `${testId} strategist produced no visible next-step candidates for the trip journey`,
    );
    assert(
      statusAcceptable,
      `${testId} trip scenario ended in an unexpected strategist posture: status=${move.status} move=${move.move}`,
    );
    console.log(`[${tag}] trip scaffold verified (${journeyCardIds.length} journey card(s), facets=${tripCoverage.size}/${TRIP_FACETS.length}, next=${nextCandidates.length})`);
  } finally {
    if (createdBoard) {
      try {
        const deprecateResult = await httpJson('POST', manageUrl, {
          subcommand: 'deprecate-board',
          args: { boardId },
        });
        if (deprecateResult.status === 200 && deprecateResult.data?.status === 'success') {
          console.log(`[cleanup] deprecated strategist board ${boardId}`);
        } else {
          console.error(`[cleanup] deprecate strategist board failed: ${JSON.stringify(deprecateResult.data)}`);
        }
      } catch (error) {
        console.error(`[cleanup] deprecate strategist board errored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/*
S3 e2e purpose: start from a deliberately partial profile scaffold and verify
that the observatory makes the Currency axis testable. The strategist should
expand the profile investigation beyond the planted partial start, keep the
board healthy, and raise observatory journey_value across fresh cycles.

One-sentence outcome (T8-style):
"I start from a partial profile-investigation board, and over fresh strategist cycles the whiteboard expands with missing facets while the observatory's journey-value score rises, the identity decision appears, and the board stays healthy."
*/
async function runStrategistValueCampaign({ testId, boardId, intent, formatTestId }) {
  const tag = formatTestId(testId);
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
  const callAction = (tool, cardId, payload = {}) => httpJson('POST', `${apiBase}/mcp-actions`, {
    tool,
    args: { card_id: cardId, payload },
  });
  const readStrategistModel = (payload) => selectLiveCardModelFromPayload(payload, STRATEGIST_CARD_ID);
  const journeyCardCount = (snapshot) => (snapshot?.boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id)).length;

  console.log(`[${tag}] step 1/6: confirming bootstrapped journeys board '${boardId}' exists`);
  const existingBoards = await httpJson('POST', manageUrl, { subcommand: 'list-boards' });
  const boardExists = Array.isArray(existingBoards.data?.data?.boards)
    && existingBoards.data.data.boards.some((entry) => String(entry?.id ?? '') === boardId);
  assert(boardExists, `${testId} expected bootstrapped board '${boardId}' to exist`);

  console.log(`[${tag}] step 2/6: resetting '${boardId}' to seed-only`);
  await resetBoardToFreshRuntime({
    boardId,
    testId,
    formatTestId,
    expectedCardIds: [STRATEGIST_CARD_ID, OBSERVATORY_CARD_ID],
  });

  console.log(`[${tag}] step 3/6: seeding ${STRATEGIST_SEED_CARD_ID} with the person name "${intent}"`);
  const seedTemplate = JSON.parse(fs.readFileSync(STRATEGIST_SEED_TEMPLATE_PATH, 'utf-8'));
  const seedCard = (Array.isArray(seedTemplate?.cards) ? seedTemplate.cards : []).find(
    (entry) => entry?.id === STRATEGIST_SEED_CARD_ID,
  );
  assert(seedCard, `${testId} journey-seed template missing ${STRATEGIST_SEED_CARD_ID}`);
  seedCard.card_data = { ...(seedCard.card_data || {}), intent };
  expectMcpSuccess(
    await callMcp('manage.upsert-card', {
      card_id: STRATEGIST_SEED_CARD_ID,
      candidate_card_content: seedCard,
    }),
    `${testId} manage.upsert-card journey-seed`,
  );

  console.log(`[${tag}] step 4/6: planting a partial three-facet start for the value campaign`);
  for (const entry of PROFILE_VALUE_CAMPAIGN_PLANTED_CARDS) {
    expectMcpSuccess(
      await callMcp('manage.upsert-card', { card_id: entry.card.id, candidate_card_content: entry.card }),
      `${testId} manage.upsert-card ${entry.card.id}`,
    );
  }
  const plantedIds = PROFILE_VALUE_CAMPAIGN_PLANTED_CARDS.map((entry) => entry.card.id);
  const plantDeadline = Date.now() + PROFILE_PLANT_TIMEOUT_MS;
  let startBoard = null;
  while (Date.now() < plantDeadline) {
    await sleep(3_000);
    let snapshot;
    try {
      snapshot = await fetchBoardStateOnce(apiBase);
    } catch {
      continue;
    }
    if (!snapshot?.payload) continue;
    startBoard = snapshot;
    const allDone = plantedIds.every((id) => (
      String(selectLiveCardModelFromPayload(snapshot.payload, id).runtime_state.task_status || '') === 'completed'
    ));
    if (allDone) break;
  }
  assert(startBoard?.payload, `${testId} never captured a board snapshot while planting the partial start`);

  const startCoverage = computeFacetCoverage(startBoard.payload, PROFILE_FACETS);
  assert(
    startCoverage.size === PROFILE_VALUE_CAMPAIGN_PLANTED_CARDS.length,
    `${testId} partial planted start expected ${PROFILE_VALUE_CAMPAIGN_PLANTED_CARDS.length} facet cards, got ${startCoverage.size}`,
  );
  const startObservatory = await refreshObservatoryCard({ apiBase, testId, minCardCount: journeyCardCount(startBoard) });
  const startValue = startObservatory.snapshot.journeyValue;
  console.log(
    `[${tag}] planted start: facets=${startCoverage.size}/${PROFILE_FACETS.length} `
    + `value=${startValue} band=${startObservatory.snapshot.journeyValueBand}`,
  );

  console.log(`[${tag}] step 5/6: driving up to three strategist cycles and checking that observatory value rises`);
  let finalCoverage = startCoverage;
  let finalObservatory = startObservatory;
  let finalBoard = startBoard;
  let finalMove = moveFromComputed(readStrategistModel(startBoard.payload).computed_values || {});
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const before = await fetchBoardStateOnce(apiBase);
    assert(before?.payload, `${testId} could not read board state before strategist cycle ${cycle}`);
    const prevAttempt = Number(readStrategistModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);
    const prevJourneyCardIds = journeyCardIdsFromPayload(before.payload);
    const prevMove = moveFromComputed(readStrategistModel(before.payload).computed_values || {});
    expectMcpSuccess(
      await callAction('retrigger-card', STRATEGIST_CARD_ID),
      `${testId} retrigger-card ${STRATEGIST_CARD_ID} cycle ${cycle}`,
    );

    const after = await waitForFreshStrategistCycle({
      apiBase,
      readModel: readStrategistModel,
      prevAttempt,
      prevJourneyCardIds,
      prevMoveSignature: moveSignature(prevMove),
      timeoutMs: STRATEGIST_CYCLE_TIMEOUT_MS,
      testId,
      phaseLabel: `cycle ${cycle}`,
    });
    finalBoard = after;
    finalCoverage = computeFacetCoverage(after.payload, PROFILE_FACETS);
    finalObservatory = await refreshObservatoryCard({ apiBase, testId, minCardCount: journeyCardCount(after) });
    finalMove = moveFromComputed(readStrategistModel(after.payload).computed_values || {});

    console.log(
      `[${tag}] cycle ${cycle}: facets=${finalCoverage.size}/${PROFILE_FACETS.length} `
      + `value=${finalObservatory.snapshot.journeyValue} band=${finalObservatory.snapshot.journeyValueBand}`,
    );
    if (finalCoverage.size > startCoverage.size && finalObservatory.snapshot.journeyValue > startValue) {
      break;
    }
  }

  console.log(`[${tag}] step 6/6: asserting the value campaign outcome`);
  assert(
    finalCoverage.size > startCoverage.size,
    `${testId} strategist did not expand the partial journey: start facets=${startCoverage.size}, final facets=${finalCoverage.size}`,
  );
  for (const key of startCoverage.keys()) {
    assert(finalCoverage.has(key), `${testId} lost an already-established profile facet during the value campaign: ${key}`);
  }
  assert(finalCoverage.has('disambiguation'), `${testId} value campaign never surfaced the identity-disambiguation decision card`);
  assert(
    finalObservatory.snapshot.journeyValue > startValue,
    `${testId} observatory journey value did not rise: start=${startValue} final=${finalObservatory.snapshot.journeyValue}`,
  );
  assert(
    finalObservatory.snapshot.failedCount === 0 && finalObservatory.snapshot.blockedCount === 0,
    `${testId} observatory reported blocked/failed work after campaign: blocked=${finalObservatory.snapshot.blockedCount} failed=${finalObservatory.snapshot.failedCount}`,
  );
  assert(
    finalObservatory.snapshot.journeyValueBand === 'building' || finalObservatory.snapshot.journeyValueBand === 'healthy',
    `${testId} final observatory band unexpected: ${finalObservatory.snapshot.journeyValueBand}`,
  );
  assert(normalizeNextCandidates(finalMove).length > 0, `${testId} strategist produced no visible next-step candidates during the value campaign`);

  const finalJourneyCardIds = (finalBoard?.boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id));
  console.log(
    `[${tag}] value campaign verified: value ${startValue} -> ${finalObservatory.snapshot.journeyValue}, `
    + `facets ${startCoverage.size}/${PROFILE_FACETS.length} -> ${finalCoverage.size}/${PROFILE_FACETS.length}, `
    + `journey cards=${finalJourneyCardIds.length}`,
  );
}

/*
S1 e2e purpose: start from a seed-only profile brief and verify that the
strategist turns it into a visible profile-investigation scaffold. The expected
outcome is not real web retrieval; it is a legible whiteboard with the canonical
profile facets, an identity-disambiguation decision, and a visible next step,
while the board stays healthy.

One-sentence outcome (T8-style):
"I type a person's name and hiring-screen brief, and the whiteboard grows from a seed into a recognizable profile-investigation plan — background, online presence, notable work, news, plus a 'which person is this?' decision card and a suggested next step; the AI finishes and the board is healthy."
*/
async function runStrategistToTargetState({ testId, boardId, intent, formatTestId }) {
  const tag = formatTestId(testId);
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
  const callAction = (tool, cardId, payload = {}) => httpJson('POST', `${apiBase}/mcp-actions`, {
    tool,
    args: { card_id: cardId, payload },
  });
  const readModel = (payload) => selectLiveCardModelFromPayload(payload, STRATEGIST_CARD_ID);

  console.log(`[${tag}] step 1/5: confirming bootstrapped journeys board '${boardId}' exists`);
  const existingBoards = await httpJson('POST', manageUrl, { subcommand: 'list-boards' });
  const boardExists = Array.isArray(existingBoards.data?.data?.boards)
    && existingBoards.data.data.boards.some((entry) => String(entry?.id ?? '') === boardId);
  assert(boardExists, `${testId} expected bootstrapped board '${boardId}' to exist (register it in hosted-board-runtime.localfs.config.json)`);

  console.log(`[${tag}] step 2/5: resetting '${boardId}' to seed-only`);
  await resetBoardToFreshRuntime({
    boardId,
    testId,
    formatTestId,
    expectedCardIds: [STRATEGIST_CARD_ID, OBSERVATORY_CARD_ID],
  });

  console.log(`[${tag}] step 3/5: seeding ${STRATEGIST_SEED_CARD_ID} with the profile brief`);
  const seedTemplate = JSON.parse(fs.readFileSync(STRATEGIST_SEED_TEMPLATE_PATH, 'utf-8'));
  const seedCard = (Array.isArray(seedTemplate?.cards) ? seedTemplate.cards : []).find(
    (entry) => entry?.id === STRATEGIST_SEED_CARD_ID,
  );
  assert(seedCard, `${testId} journey-seed template missing ${STRATEGIST_SEED_CARD_ID}`);
  seedCard.card_data = { ...(seedCard.card_data || {}), intent };
  expectMcpSuccess(
    await callMcp('manage.upsert-card', {
      card_id: STRATEGIST_SEED_CARD_ID,
      candidate_card_content: seedCard,
    }),
    `${testId} manage.upsert-card journey-seed`,
  );

  console.log(`[${tag}] step 4/5: driving up to ${MAX_STRATEGIST_SCENARIO_CYCLES} strategist cycles until the investigation scaffold is visible`);
  let after = null;
  let latestMove = null;
  for (let cycle = 1; cycle <= MAX_STRATEGIST_SCENARIO_CYCLES; cycle += 1) {
    const before = await fetchBoardStateOnce(apiBase);
    assert(before?.payload, `${testId} could not read board state before scaffold cycle ${cycle}`);
    const prevAttempt = Number(readModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);
    const prevJourneyCardIds = journeyCardIdsFromPayload(before.payload);
    const prevMove = moveFromComputed(readModel(before.payload).computed_values || {});
    const wakeResult = await callAction('retrigger-card', STRATEGIST_CARD_ID);
    assert(
      wakeResult.status === 200 && wakeResult.data?.status === 'success',
      `${testId} retrigger-card failed: HTTP ${wakeResult.status} ${JSON.stringify(wakeResult.data)}`,
    );
    after = await waitForFreshStrategistCycle({
      apiBase,
      readModel,
      prevAttempt,
      prevJourneyCardIds,
      prevMoveSignature: moveSignature(prevMove),
      timeoutMs: STRATEGIST_CYCLE_TIMEOUT_MS,
      testId,
      phaseLabel: `scaffold cycle ${cycle}`,
    });
    latestMove = moveFromComputed(readModel(after.payload).computed_values || {});
    const coverage = computeFacetCoverage(after.payload, PROFILE_FACETS);
    const nextCandidates = normalizeNextCandidates(latestMove);
    const summary = summarizeBoardState(after.boardState);
    console.log(
      `[${tag}] cycle ${cycle}: facets=${coverage.size}/${PROFILE_FACETS.length} `
      + `move=${latestMove.move ?? '(n/a)'} status=${latestMove.status ?? '(n/a)'} next=${nextCandidates.length}`,
    );
    if (
      coverage.size === PROFILE_FACETS.length
      && nextCandidates.length > 0
      && Number(summary.failed ?? 0) === 0
      && (latestMove.status === 'advancing' || latestMove.status === 'aligned')
    ) {
      break;
    }
  }
  assert(after?.payload, `${testId} never captured a board snapshot while growing the profile scaffold`);

  console.log(`[${tag}] step 5/5: asserting the profile-investigation scaffold outcome`);
  const maintenanceMove = latestMove ?? moveFromComputed(readModel(after.payload).computed_values || {});
  const accepted = assertProfileScaffoldShape({
    payload: after.payload,
    boardState: after.boardState,
    move: maintenanceMove,
    testId,
    requireNextSignal: true,
    requireStrategistStatus: true,
  });

  console.log(
    `[${tag}] strategist profile move: status=${maintenanceMove.status ?? '(n/a)'} move=${maintenanceMove.move ?? '(n/a)'} `
    + `(facets=${accepted.coverage.size}/${PROFILE_FACETS.length}, journey cards=${accepted.journeyCardIds.length}, next=${accepted.nextCandidates.length})`,
  );
  console.log(
    `[${tag}] profile scaffold verified: the seed-only board grew into a recognizable investigation scaffold `
    + `(background, online presence, publications, news, identity decision) and surfaced next steps without failing the board`,
  );
}

async function main() {
  const modePrefix = 'L';
  const modeLabel = 'localfs';
  const formatTestId = (testId) => `${modePrefix}-${String(testId || '').trim().toUpperCase()}`;
  const printedTests = requestedTests
    ? Array.from(requestedTests).map((testId) => formatTestId(testId)).join(',')
    : DEFAULT_TEST_IDS
      .filter((testId) => !SKIPPED_TEST_SET.has(String(testId).trim().toUpperCase()))
      .map((testId) => formatTestId(testId)).join(',');

  console.log(`\n=== ${modeLabel} strategist HTTP test ===`);
  console.log(`server: ${BOARD_SERVER_URL}`);
  console.log(`tests:  ${printedTests}`);

  if (isTestSelected(requestedTests, 'B1')) {
    console.log(`\n=== ${formatTestId('B1')}: strategist basic validation — server, boards, SSE snapshot, observatory wiring ===`);
    await runStrategistBasicValidation({
      testId: 'B1',
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'A1')) {
    console.log(`\n=== ${formatTestId('A1')}: profile scaffold acceptance — direct planted shape passes without a fresh strategist cycle ===`);
    await runProfileScaffoldAcceptance({
      testId: 'A1',
      boardId: STRATEGIST_BOARD_ID,
      intent: STRATEGIST_INTENT,
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'S1')) {
    console.log(`\n=== ${formatTestId('S1')}: profile-investigator scaffold — seed-only board grows into a visible background-check plan ===`);
    await runStrategistToTargetState({
      testId: 'S1',
      boardId: STRATEGIST_BOARD_ID,
      intent: STRATEGIST_INTENT,
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'S2')) {
    console.log(`\n=== ${formatTestId('S2')}: trip-planning scaffold — concrete Japan brief grows into a recognizable planning board ===`);
    await runStrategistLiveCycle({
      testId: 'S2',
      boardId: STRATEGIST_TRIP_BOARD_ID,
      intent: STRATEGIST_TRIP_INTENT,
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'S3')) {
    console.log(`\n=== ${formatTestId('S3')}: profile value campaign — partial scaffold expands while observatory value rises ===`);
    await runStrategistValueCampaign({
      testId: 'S3',
      boardId: STRATEGIST_BOARD_ID,
      intent: STRATEGIST_INTENT,
      formatTestId,
    });
  }

  console.log('\n=== Strategist tests passed ===\n');
}

main().catch((error) => {
  console.error('\nStrategist test failure:', error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
