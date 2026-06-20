#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNotification, buildBoardState } from 'yaml-flow/board-state-reducer';
import { runtimeNotificationsFromPayload } from 'yaml-flow/notification-consumer';
import {
  ADMIN_CARD_IDS,
  behavioralChecks,
  createdCardIds as moveCreatedCardIds,
  moveFromComputed,
  validateMove,
} from './strategist/lib/strategist-harness-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliArgs = process.argv.slice(2);
const DEFAULT_TEST_IDS = ['S1', 'S2', 'S3'];
const DEFAULT_TEST_SET = new Set(DEFAULT_TEST_IDS);

function readCliOptionValue(args, optionName) {
  const optionIndex = args.indexOf(optionName);
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

function jsonText(value) {
  return JSON.stringify(value);
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

function normalizeSseChunkBuffer(buffer, chunk) {
  return `${buffer}${chunk}`.replace(/\r\n/g, '\n');
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

function createEmptyHostedSseSnapshot() {
  return {
    boardState: null,
  };
}

function applyHostedSseFrame(prev, payload, latestPayloadRef) {
  const base = prev ?? createEmptyHostedSseSnapshot();
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
        buffer = normalizeSseChunkBuffer(buffer, chunk);
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.remainder;
        const payload = parsed.payloads.find((entry) => Array.isArray(entry?.cardDefinitions));
        if (payload) {
          const snapshot = applyHostedSseFrame(createEmptyHostedSseSnapshot(), payload, () => payload);
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
  assert(result.status === 200, `${label} returned HTTP ${result.status}: ${jsonText(result.data)}`);
  assert(result.data?.status === 'success', `${label} failed: ${jsonText(result.data)}`);
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
const STRATEGIST_INTENT = 'Alex Rivera';
const STRATEGIST_TRIP_BOARD_ID = 'trip';
const STRATEGIST_TRIP_INTENT = 'Plan a 10-day late-October trip to Japan for two, balancing a few days in Tokyo, a traditional ryokan onsen stay near Hakone, and temple-focused time in Kyoto, on a mid-range budget';
const PROFILE_PLANT_TIMEOUT_MS = 120_000;
const PROFILE_FACETS = [
  { key: 'linkedin', label: 'LinkedIn / Professional Background', match: /linkedin|professional background|career|work experience/i },
  { key: 'social', label: 'Social Media Handles', match: /social|handle|online presence/i },
  { key: 'publications', label: 'Patents & Publications', match: /patent|publication|paper|notable work/i },
  { key: 'news', label: 'News & Press Mentions', match: /news|press|media mention/i },
  { key: 'disambiguation', label: 'Identity Disambiguation', match: /disambiguat|identity|which .*(person|alex)/i, decision: true },
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

function computeProfileFacetCoverage(payload) {
  const defs = Array.isArray(payload?.cardDefinitions) ? payload.cardDefinitions : [];
  const cards = defs.filter(
    (def) => def?.id
      && !ADMIN_CARD_IDS.has(def.id)
      && def.id !== STRATEGIST_SEED_CARD_ID,
  );
  const coverage = new Map();
  for (const facet of PROFILE_FACETS) {
    const hit = cards.find((card) => {
      const tags = Array.isArray(card?.meta?.tags) ? card.meta.tags.map((tag) => String(tag)) : [];
      const haystack = `${String(card?.meta?.title || '')} ${tags.join(' ')}`.toLowerCase();
      return facet.match.test(haystack);
    });
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

async function runStrategistLiveCycle({ testId, boardId, intent, formatTestId }) {
  const tag = formatTestId(testId);
  const apiBase = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(boardId)}`;
  const manageUrl = `${BOARD_SERVER_URL}/manage-boards`;
  const callMcp = (tool, args) => httpJson('POST', `${apiBase}/mcp`, { tool, args });
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
      console.log(`[${tag}] step 1/6: reusing existing journeys board '${boardId}' (left intact on cleanup)`);
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
        `${testId} add-board failed: HTTP ${addResult.status} ${jsonText(addResult.data)}`,
      );
      createdBoard = true;
    }

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

    console.log(`[${tag}] step 3/6: reading pre-run strategist state`);
    const before = await fetchBoardStateOnce(apiBase);
    assert(before?.payload, `${testId} could not read board state before the run`);
    const prevAttempt = Number(readModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);

    console.log(`[${tag}] step 4/6: waking ${STRATEGIST_CARD_ID}`);
    const wakeResult = await callAction('retrigger-card', STRATEGIST_CARD_ID);
    assert(
      wakeResult.status === 200 && wakeResult.data?.status === 'success',
      `${testId} retrigger-card failed: HTTP ${wakeResult.status} ${jsonText(wakeResult.data)}`,
    );

    console.log(`[${tag}] step 5/6: waiting for ${STRATEGIST_CARD_ID} to complete a fresh cycle (real copilot CLI, may take minutes)`);
    const deadline = Date.now() + STRATEGIST_CYCLE_TIMEOUT_MS;
    let sawBusy = false;
    let after = null;
    while (Date.now() < deadline) {
      await sleep(5_000);
      let snapshot;
      try {
        snapshot = await fetchBoardStateOnce(apiBase);
      } catch {
        continue;
      }
      if (!snapshot?.payload) continue;
      const rt = readModel(snapshot.payload).runtime_state;
      const status = String(rt.task_status || '');
      if (status === 'running' || status === 'in-progress') sawBusy = true;
      const attempt = Number(rt.runtime?.attempt_count ?? 0);
      if (sawBusy && status === 'completed' && attempt > prevAttempt) {
        after = snapshot;
        break;
      }
    }
    assert(after, `${testId} strategist did not complete a fresh cycle within ${STRATEGIST_CYCLE_TIMEOUT_MS}ms`);

    console.log(`[${tag}] step 6/6: validating the strategist move`);
    let move = moveFromComputed(readModel(after.payload).computed_values || {});
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
      move = moveFromComputed(readModel(after.payload).computed_values || {});
    }

    const journeyCardIds = (after.boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id));
    const createdThisMove = new Set(moveCreatedCardIds(move));
    const contractBoardState = {
      cardIds: journeyCardIds.filter((id) => !createdThisMove.has(id)),
      policy: STRATEGIST_POLICY,
    };
    const contract = validateMove(move, contractBoardState);
    const summary = summarizeBoardState(after.boardState);
    const behavior = behavioralChecks(move, journeyCardIds, summary);

    console.log(
      `[${tag}] move: status=${move.status ?? '(n/a)'} move=${move.move ?? '(n/a)'} `
      + `created=${(move.created_cards || []).length} updated=${(move.updated_cards || []).length}`,
    );
    for (const warning of contract.warnings) {
      console.log(`[${tag}] warning (contract): ${warning}`);
    }
    assert(contract.ok, `${testId} move violates the strategist contract: ${jsonText(contract.errors)}`);
    for (const [label, ok] of behavior.checks) {
      assert(ok, `${testId} behavioral check failed: ${label}`);
      console.log(`[${tag}] behavior PASS: ${label}`);
    }
    console.log(`[${tag}] journey-strategist live cycle verified (${journeyCardIds.length} journey card(s) on board)`);
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
          console.error(`[cleanup] deprecate strategist board failed: ${jsonText(deprecateResult.data)}`);
        }
      } catch (error) {
        console.error(`[cleanup] deprecate strategist board errored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

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
  const preReset = await fetchBoardStateOnce(apiBase);
  const resetCardIds = (preReset?.boardState?.cardIds ?? []).filter(
    (id) => !ADMIN_CARD_IDS.has(id) && id !== STRATEGIST_SEED_CARD_ID,
  );
  for (const cardId of resetCardIds) {
    const removeResult = await callMcp('manage.remove-card', { card_id: cardId });
    const removeMissing = removeResult.status === 404
      && typeof removeResult.data?.error === 'string'
      && removeResult.data.error.includes('not found');
    if (!removeMissing) {
      expectMcpSuccess(removeResult, `${testId} manage.remove-card ${cardId}`);
    }
  }

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

  const startCoverage = computeProfileFacetCoverage(startBoard.payload);
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
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const before = await fetchBoardStateOnce(apiBase);
    assert(before?.payload, `${testId} could not read board state before strategist cycle ${cycle}`);
    const prevAttempt = Number(readStrategistModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);
    expectMcpSuccess(
      await callAction('retrigger-card', STRATEGIST_CARD_ID),
      `${testId} retrigger-card ${STRATEGIST_CARD_ID} cycle ${cycle}`,
    );

    const deadline = Date.now() + STRATEGIST_CYCLE_TIMEOUT_MS;
    let sawBusy = false;
    let after = null;
    while (Date.now() < deadline) {
      await sleep(5_000);
      let snapshot;
      try {
        snapshot = await fetchBoardStateOnce(apiBase);
      } catch {
        continue;
      }
      if (!snapshot?.payload) continue;
      const rt = readStrategistModel(snapshot.payload).runtime_state;
      const status = String(rt.task_status || '');
      if (status === 'running' || status === 'in-progress') sawBusy = true;
      const attempt = Number(rt.runtime?.attempt_count ?? 0);
      if (sawBusy && status === 'completed' && attempt > prevAttempt) {
        after = snapshot;
        break;
      }
    }
    assert(after, `${testId} strategist did not complete cycle ${cycle} within ${STRATEGIST_CYCLE_TIMEOUT_MS}ms`);
    finalBoard = after;
    finalCoverage = computeProfileFacetCoverage(after.payload);
    finalObservatory = await refreshObservatoryCard({ apiBase, testId, minCardCount: journeyCardCount(after) });

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

  const finalJourneyCardIds = (finalBoard?.boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id));
  console.log(
    `[${tag}] value campaign verified: value ${startValue} -> ${finalObservatory.snapshot.journeyValue}, `
    + `facets ${startCoverage.size}/${PROFILE_FACETS.length} -> ${finalCoverage.size}/${PROFILE_FACETS.length}, `
    + `journey cards=${finalJourneyCardIds.length}`,
  );
}

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
  const preReset = await fetchBoardStateOnce(apiBase);
  const resetCardIds = (preReset?.boardState?.cardIds ?? []).filter(
    (id) => !ADMIN_CARD_IDS.has(id) && id !== STRATEGIST_SEED_CARD_ID,
  );
  for (const cardId of resetCardIds) {
    const removeResult = await callMcp('manage.remove-card', { card_id: cardId });
    if (removeResult.status !== 200 || removeResult.data?.status !== 'success') {
      console.error(`[${tag}] reset: remove-card ${cardId} -> ${jsonText(removeResult.data)}`);
    }
  }
  if (resetCardIds.length > 0) console.log(`[${tag}] reset removed ${resetCardIds.length} prior journey card(s)`);

  console.log(`[${tag}] step 3/5: seeding ${STRATEGIST_SEED_CARD_ID} with the person name "${intent}"`);
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

  console.log(`[${tag}] step 4/5: planting the five mock-backed facet cards`);
  for (const entry of PROFILE_PLANTED_CARDS) {
    expectMcpSuccess(
      await callMcp('manage.upsert-card', { card_id: entry.card.id, candidate_card_content: entry.card }),
      `${testId} manage.upsert-card ${entry.card.id}`,
    );
  }
  const plantedIds = PROFILE_PLANTED_CARDS.map((entry) => entry.card.id);
  const plantDeadline = Date.now() + PROFILE_PLANT_TIMEOUT_MS;
  let after = null;
  while (Date.now() < plantDeadline) {
    await sleep(3_000);
    let snapshot;
    try {
      snapshot = await fetchBoardStateOnce(apiBase);
    } catch {
      continue;
    }
    if (!snapshot?.payload) continue;
    after = snapshot;
    const allDone = plantedIds.every((id) => (
      String(selectLiveCardModelFromPayload(snapshot.payload, id).runtime_state.task_status || '') === 'completed'
    ));
    if (allDone) break;
  }
  assert(after?.payload, `${testId} never captured a board snapshot while planting`);
  for (const entry of PROFILE_PLANTED_CARDS) {
    const model = selectLiveCardModelFromPayload(after.payload, entry.card.id);
    const status = String(model.runtime_state.task_status || '');
    assert(status === 'completed', `${testId} planted card ${entry.card.id} did not complete (status=${status || 'none'})`);
    const marker = Number(model.computed_values?.probe_count);
    assert(
      marker === entry.expectCount,
      `${testId} planted card ${entry.card.id} mock data mismatch: probe_count=${marker} expected ${entry.expectCount}`,
    );
    console.log(`[${tag}] planted PASS: ${entry.card.meta.title} -> ${entry.card.id} (probe_count=${marker})`);
  }

  console.log(`[${tag}] step 5/5: waking the strategist once to confirm it maintains the aligned board`);
  const before = await fetchBoardStateOnce(apiBase);
  assert(before?.payload, `${testId} could not read board state before the maintenance cycle`);
  const prevAttempt = Number(readModel(before.payload).runtime_state.runtime?.attempt_count ?? 0);
  const wakeResult = await callAction('retrigger-card', STRATEGIST_CARD_ID);
  assert(
    wakeResult.status === 200 && wakeResult.data?.status === 'success',
    `${testId} retrigger-card failed: HTTP ${wakeResult.status} ${jsonText(wakeResult.data)}`,
  );
  const deadline = Date.now() + STRATEGIST_CYCLE_TIMEOUT_MS;
  let sawBusy = false;
  let maintained = null;
  while (Date.now() < deadline) {
    await sleep(5_000);
    let snapshot;
    try {
      snapshot = await fetchBoardStateOnce(apiBase);
    } catch {
      continue;
    }
    if (!snapshot?.payload) continue;
    const rt = readModel(snapshot.payload).runtime_state;
    const status = String(rt.task_status || '');
    if (status === 'running' || status === 'in-progress') sawBusy = true;
    const attempt = Number(rt.runtime?.attempt_count ?? 0);
    if (sawBusy && status === 'completed' && attempt > prevAttempt) {
      maintained = snapshot;
      break;
    }
  }
  assert(maintained, `${testId} strategist did not complete a maintenance cycle within ${STRATEGIST_CYCLE_TIMEOUT_MS}ms`);
  after = maintained;

  const coverage = computeProfileFacetCoverage(after.payload);
  const missingFacets = PROFILE_FACETS.filter((facet) => !coverage.has(facet.key));
  assert(
    missingFacets.length === 0,
    `${testId} strategist degraded the board — missing facet card(s) after maintenance: ${missingFacets.map((facet) => facet.label).join('; ')}`,
  );
  const decisionFacet = PROFILE_FACETS.find((facet) => facet.decision);
  assert(
    decisionFacet && coverage.has(decisionFacet.key),
    `${testId} identity-disambiguation decision card missing after maintenance`,
  );
  const maintenanceMove = moveFromComputed(readModel(after.payload).computed_values || {});
  const journeyCardIds = (after.boardState?.cardIds ?? []).filter((id) => !ADMIN_CARD_IDS.has(id));
  const summary = summarizeBoardState(after.boardState);
  assert(Number(summary.failed ?? 0) === 0, `${testId} board has ${summary.failed} failed card(s) after maintenance`);

  console.log(
    `[${tag}] strategist maintenance move: status=${maintenanceMove.status ?? '(n/a)'} move=${maintenanceMove.move ?? '(n/a)'} `
    + `(facets intact ${coverage.size}/${PROFILE_FACETS.length}, ${journeyCardIds.length} journey card(s), board healthy)`,
  );
  console.log(
    `[${tag}] target state verified: all ${PROFILE_FACETS.length} mock-backed facet cards present and populated `
    + `(incl. identity decision), strategist maintained the aligned board, board healthy`,
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

  if (isTestSelected(requestedTests, 'S1')) {
    console.log(`\n=== ${formatTestId('S1')}: profile-investigator journey — seed a name, grow the board to its five-facet target state ===`);
    await runStrategistToTargetState({
      testId: 'S1',
      boardId: STRATEGIST_BOARD_ID,
      intent: STRATEGIST_INTENT,
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'S2')) {
    console.log(`\n=== ${formatTestId('S2')}: journey-strategist live cycle on the 'trip' second domain ===`);
    await runStrategistLiveCycle({
      testId: 'S2',
      boardId: STRATEGIST_TRIP_BOARD_ID,
      intent: STRATEGIST_TRIP_INTENT,
      formatTestId,
    });
  }

  if (isTestSelected(requestedTests, 'S3')) {
    console.log(`\n=== ${formatTestId('S3')}: profile journey value campaign — partial planted start, strategist lifts observatory value ===`);
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
