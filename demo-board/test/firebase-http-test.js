#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeFirebaseServices } from '../server/hosted-board-runtime/firebase-adapter/firebase-init.js';
import { loadFirebaseHostConfig } from '../server/hosted-board-runtime/firebase-adapter/load-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliArgs = process.argv.slice(2);

function readCliOptionValue(args, optionName) {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex === -1) return '';
  return String(args[optionIndex + 1] || '').trim();
}

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
  return !requestedTests || requestedTests.has(String(testId || '').trim().toUpperCase());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function jsonText(value) {
  return JSON.stringify(value);
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

async function probeHealthz(serverUrl) {
  try {
    const result = await httpJson('GET', `${serverUrl}/healthz`);
    if (result.status !== 200 || result.data?.ok !== true) {
      return { ok: false, result };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectMcpSuccess(result, label) {
  assert(result.status === 200, `${label} returned HTTP ${result.status}: ${jsonText(result.data)}`);
  assert(result.data?.status === 'success', `${label} failed: ${jsonText(result.data)}`);
  return result.data?.data ?? null;
}

function loadCardFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'live-cards', fileName), 'utf-8'));
}

function cloneCardWithId(card, id) {
  const clone = deepCloneJson(card);
  clone.id = id;
  return clone;
}

function readStoredCard(readData) {
  return Array.isArray(readData) ? readData[0] || null : null;
}

function findBoardStatusCard(statusData, cardId) {
  const cards = Array.isArray(statusData?.cards) ? statusData.cards : [];
  return cards.find((card) => String(card?.['card-id'] || '') === cardId) || null;
}

function createPollProgress(label) {
  let started = false;
  return {
    tick() {
      if (!started) {
        process.stdout.write(`(waiting for ${label})`);
        started = true;
      }
      process.stdout.write('.');
    },
    done() {
      if (started) {
        process.stdout.write('\n');
      }
    },
  };
}

async function pollBoardStatus(callMcp, attempts, gapMs, predicate, waitLabel = 'board status') {
  let lastStatusData = null;
  const progress = createPollProgress(waitLabel);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    progress.tick();
    const statusData = expectMcpSuccess(
      await callMcp('inspect.board-runtime-status', {}),
      `inspect.board-runtime-status attempt ${attempt}`,
    );
    lastStatusData = statusData;
    if (predicate(statusData)) {
      progress.done();
      return { matched: true, attemptsUsed: attempt, statusData };
    }
    if (attempt < attempts) {
      await sleep(gapMs);
    }
  }
  progress.done();
  return { matched: false, attemptsUsed: attempts, statusData: lastStatusData };
}

function computeExpectedPortfolioValue(holdings, priceRows) {
  const holdingsMap = new Map(
    (Array.isArray(holdings) ? holdings : []).map((row) => [
      String(row?.ticker || '').trim().toUpperCase(),
      Number(row?.quantity),
    ]),
  );

  return roundMoney(
    (Array.isArray(priceRows) ? priceRows : []).reduce((sum, row) => {
      const ticker = String(row?.ticker || row?.symbol || '').trim().toUpperCase();
      const quantity = holdingsMap.get(ticker);
      const price = Number(row?.price ?? row?.regularMarketPrice);
      if (!ticker || !Number.isFinite(quantity) || !Number.isFinite(price)) {
        return sum;
      }
      return sum + (quantity * price);
    }, 0),
  );
}

const QUEUE_RUNNER_CONFIG_PATH = path.resolve(__dirname, '../server/hosted-board-runtime/queue-runner/queue-runner.config.json');
let hostedFirebaseContextPromise = null;

async function getHostedFirebaseContext() {
  if (!hostedFirebaseContextPromise) {
    hostedFirebaseContextPromise = (async () => {
      const hostConfig = loadFirebaseHostConfig(QUEUE_RUNNER_CONFIG_PATH, []);
      const firebaseServices = await initializeFirebaseServices(hostConfig.firebase);
      return { hostConfig, firebaseServices };
    })();
  }
  return hostedFirebaseContextPromise;
}

async function cleanupHostedFirebaseContext() {
  if (!hostedFirebaseContextPromise) return;
  const pending = hostedFirebaseContextPromise;
  hostedFirebaseContextPromise = null;
  try {
    const context = await pending;
    if (typeof context?.firebaseServices?.app?.delete === 'function') {
      await context.firebaseServices.app.delete();
    }
  } catch {
  }
}

function makeQueueMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function enqueueProcessAccumulatedWakeup(boardId) {
  const { firebaseServices } = await getHostedFirebaseContext();
  const id = makeQueueMessageId('process-accumulated-test');
  const nowIso = new Date().toISOString();
  const queueDoc = {
    id,
    body: { boardRef: `manual:${boardId}` },
    dedupKey: `manual-process-accumulated:${id}`,
    enqueuedAt: nowIso,
    attempt: 0,
    visibleAfter: nowIso,
    leaseToken: null,
    leaseExpiresAt: null,
    dead: false,
    deadReason: null,
  };
  await firebaseServices.firestore.collection(`boards/${boardId}/process-queue`).doc(id).set(queueDoc);
  return { id };
}

async function readProcessAccumulatedWakeup(boardId, id) {
  const { firebaseServices } = await getHostedFirebaseContext();
  const snap = await firebaseServices.firestore.collection(`boards/${boardId}/process-queue`).doc(id).get();
  return snap.exists ? snap.data() ?? null : null;
}

const portArg = readCliOptionValue(cliArgs, '--port');
const cliBoardId = readCliOptionValue(cliArgs, '--board-id') || readCliOptionValue(cliArgs, '--board');
const requestedTests = parseRequestedTests(readCliOptionValue(cliArgs, '--run-tests'));

const BOARD_ID = cliBoardId || 'live';
const BOARD_SERVER_URL = portArg ? `http://127.0.0.1:${portArg}` : 'http://127.0.0.1:7799';
const API_BASE = `${BOARD_SERVER_URL}/api/boards/${encodeURIComponent(BOARD_ID)}`;

const PORTFOLIO_CARD_ID = 'card-portfolio-tc1-9008';
const MARKET_PRICES_CARD_ID = 'market-prices-tc2-9027';
const PORTFOLIO_VALUE_CARD_ID = 'portfolio-value-tc3-9043';

const portfolioSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio.json'), PORTFOLIO_CARD_ID);
const portfolioT2SeedCard = (() => {
  const clone = deepCloneJson(portfolioSeedCard);
  clone.card_data = clone.card_data && typeof clone.card_data === 'object' ? clone.card_data : {};
  const holdings = Array.isArray(clone.card_data.holdings) ? clone.card_data.holdings : [];
  clone.card_data.holdings = [
    ...holdings,
    {
      ticker: 'AMZN',
      quantity: 4,
      cost_basis: 180,
    },
  ];
  return clone;
})();
const marketPricesSeedCard = cloneCardWithId(loadCardFixture('cardT-market-prices.json'), MARKET_PRICES_CARD_ID);
const portfolioValueSeedCard = cloneCardWithId(loadCardFixture('cardT-portfolio-value.json'), PORTFOLIO_VALUE_CARD_ID);

async function main() {
  console.log('\n=== firebase controlface MCP smoke test ===');
  console.log(`target: ${API_BASE}`);
  console.log(`board:  ${BOARD_ID}`);
  console.log(`tests:  ${requestedTests ? Array.from(requestedTests).join(',') : 'T0,T1,T2,TQ'}`);

  const healthz = await probeHealthz(BOARD_SERVER_URL);
  if (!healthz.ok) {
    const detail = healthz.error instanceof Error
      ? healthz.error.message
      : jsonText(healthz.result?.data || healthz.result || null);
    console.log(`[setup] skipping: controlface server is not available at ${BOARD_SERVER_URL} (${detail})`);
    return;
  }

  const boards = Array.isArray(healthz.result?.data?.boards) ? healthz.result.data.boards : [];
  assert(boards.includes(BOARD_ID), `healthz does not list board '${BOARD_ID}': ${jsonText(boards)}`);
  console.log(`[setup] healthz ok: boards=${jsonText(boards)}`);

  const createdCardIds = [];
  const callMcp = (tool, args) => httpJson('POST', `${API_BASE}/mcp`, { tool, args });

  try {
    if (isTestSelected(requestedTests, 'T0')) {
      console.log(`\n=== T0: seed ${PORTFOLIO_CARD_ID} and verify persistence + completed status ===`);

      expectMcpSuccess(
        await callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioSeedCard,
        }),
        'T0 manage.upsert-card',
      );
      createdCardIds.push(PORTFOLIO_CARD_ID);

      const storedPortfolio = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T0 manage.read-card',
        ),
      );
      assert(!!storedPortfolio, 'T0 manage.read-card returned no card');
      assert(
        jsonText(canonicalizeJson(storedPortfolio)) === jsonText(canonicalizeJson(portfolioSeedCard)),
        `T0 stored card mismatch for ${PORTFOLIO_CARD_ID}`,
      );
      console.log('[T0] stored card matches seeded card');

      const t0Poll = await pollBoardStatus(callMcp, 5, 1000, (statusData) => {
        const card = findBoardStatusCard(statusData, PORTFOLIO_CARD_ID);
        return card && String(card.status || '') === 'completed';
      }, `${PORTFOLIO_CARD_ID} to reach completed`);
      assert(
        t0Poll.matched,
        `T0 timed out waiting for ${PORTFOLIO_CARD_ID} to reach completed: ${jsonText(t0Poll.statusData)}`,
      );
      console.log(`[T0] completed in ${t0Poll.attemptsUsed} poll(s)`);
    }

    if (isTestSelected(requestedTests, 'T1')) {
      console.log(`\n=== T1: discover + preflight tests for ${MARKET_PRICES_CARD_ID} + ${PORTFOLIO_VALUE_CARD_ID} ===`);

      const sourceKinds = expectMcpSuccess(
        await callMcp('discover.source-kinds', {}),
        'T1 discover.source-kinds',
      );
      assert(sourceKinds && typeof sourceKinds === 'object', 'T1 discover.source-kinds returned no payload');
      assert(
        sourceKinds.sourceKinds && typeof sourceKinds.sourceKinds === 'object' && Object.keys(sourceKinds.sourceKinds).length > 0,
        `T1 discover.source-kinds returned no source kinds: ${jsonText(sourceKinds)}`,
      );
      console.log(`[T1] discover.source-kinds ok: ${Object.keys(sourceKinds.sourceKinds).length} kind(s)`);

      const marketPricesPreflight = expectMcpSuccess(
        await callMcp('preflight.validate-candidate-card-definition', {
          candidate_card_content: marketPricesSeedCard,
        }),
        'T1 preflight.validate-candidate-card-definition market-prices',
      );
      assert(marketPricesPreflight?.cardId === MARKET_PRICES_CARD_ID, `T1 market-prices preflight cardId mismatch: ${jsonText(marketPricesPreflight)}`);
      assert(marketPricesPreflight?.isValid === true, `T1 market-prices preflight invalid: ${jsonText(marketPricesPreflight)}`);
      assert(Array.isArray(marketPricesPreflight?.issues), `T1 market-prices preflight issues shape invalid: ${jsonText(marketPricesPreflight)}`);
      console.log('[T1] market-prices candidate preflight passed');

      const storedPortfolioForPreflight = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T1 manage.read-card portfolio for source preflight',
        ),
      );
      const holdingsForPreflight = storedPortfolioForPreflight?.card_data?.holdings;
      assert(
        Array.isArray(holdingsForPreflight) && holdingsForPreflight.length > 0,
        'T1 portfolio holdings missing for market-prices source preflight',
      );
      const marketPricesMockProjections = {
        quote_urls: holdingsForPreflight.map((row) => {
          const ticker = String(row?.ticker || '').trim().toUpperCase();
          return `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        }).filter(Boolean),
      };

      const marketPricesProbe = expectMcpSuccess(
        await callMcp('preflight.probe-single-source-in-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          source_idx: 0,
          mock_projections: marketPricesMockProjections,
        }),
        'T1 preflight.probe-single-source-in-candidate-card market-prices',
      );
      assert(marketPricesProbe?.bindTo === 'quotes', `T1 market-prices source probe bindTo mismatch: ${jsonText(marketPricesProbe)}`);
      assert(typeof marketPricesProbe?.reachable === 'boolean', `T1 market-prices source probe reachable shape invalid: ${jsonText(marketPricesProbe)}`);
      assert(marketPricesProbe?.reachable === true, `T1 market-prices source probe unreachable: ${jsonText(marketPricesProbe)}`);
      if (marketPricesProbe?.latencyMs !== undefined) {
        assert(Number.isFinite(Number(marketPricesProbe.latencyMs)), `T1 market-prices source probe latencyMs shape invalid: ${jsonText(marketPricesProbe)}`);
      }
      console.log('[T1] market-prices source probe preflight passed');

      const marketPricesRun = expectMcpSuccess(
        await callMcp('preflight.run-single-source-in-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          source_idx: 0,
          mock_projections: marketPricesMockProjections,
        }),
        'T1 preflight.run-single-source-in-candidate-card market-prices',
      );
      assert(marketPricesRun?.bindTo === 'quotes', `T1 market-prices source run bindTo mismatch: ${jsonText(marketPricesRun)}`);
      assert(typeof marketPricesRun?.ok === 'boolean', `T1 market-prices source run ok shape invalid: ${jsonText(marketPricesRun)}`);
      assert(Array.isArray(marketPricesRun?.issues), `T1 market-prices source run issues shape invalid: ${jsonText(marketPricesRun)}`);
      assert(marketPricesRun?.ok === true, `T1 market-prices source run failed: ${jsonText(marketPricesRun)}`);
      console.log('[T1] market-prices source run preflight passed');

      const marketPricesCycle = expectMcpSuccess(
        await callMcp('preflight.run-one-cycle-with-candidate-card', {
          candidate_card_content: marketPricesSeedCard,
          mock_requires: {
            holdings: holdingsForPreflight,
          },
        }),
        'T1 preflight.run-one-cycle-with-candidate-card market-prices',
      );
      assert(marketPricesCycle?.cardId === MARKET_PRICES_CARD_ID, `T1 market-prices cycle cardId mismatch: ${jsonText(marketPricesCycle)}`);
      assert(typeof marketPricesCycle?.ok === 'boolean', `T1 market-prices cycle ok shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle?.issues), `T1 market-prices cycle issues shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.ok === true, `T1 market-prices cycle failed: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.issues.length === 0, `T1 market-prices cycle issues not empty: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.provides_outputs && typeof marketPricesCycle.provides_outputs === 'object', `T1 market-prices cycle provides_outputs shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle?.provides_outputs?.quotes?.quoteResponse?.error === null, `T1 market-prices cycle quotes payload error mismatch: ${jsonText(marketPricesCycle)}`);
      assert(
        Array.isArray(marketPricesCycle?.provides_outputs?.quotes?.quoteResponse?.result)
        && marketPricesCycle.provides_outputs.quotes.quoteResponse.result.length > 0,
        `T1 market-prices cycle quotes payload missing results: ${jsonText(marketPricesCycle)}`,
      );
      assert(marketPricesCycle?.rendered_view && typeof marketPricesCycle.rendered_view === 'object', `T1 market-prices cycle rendered_view shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle?.rendered_view?.elements), `T1 market-prices cycle rendered_view elements shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle.rendered_view.elements.length > 0, `T1 market-prices cycle rendered_view elements empty: ${jsonText(marketPricesCycle)}`);
      assert(Array.isArray(marketPricesCycle.rendered_view.elements[0]?.resolved), `T1 market-prices cycle rendered_view first resolved shape invalid: ${jsonText(marketPricesCycle)}`);
      assert(marketPricesCycle.rendered_view.elements[0].resolved.length > 0, `T1 market-prices cycle rendered_view first resolved empty: ${jsonText(marketPricesCycle)}`);
      console.log('[T1] market-prices simulate-card-cycle preflight passed');

      const portfolioValuePreflight = expectMcpSuccess(
        await callMcp('preflight.validate-candidate-card-definition', {
          candidate_card_content: portfolioValueSeedCard,
        }),
        'T1 preflight.validate-candidate-card-definition portfolio-value',
      );
      assert(portfolioValuePreflight?.cardId === PORTFOLIO_VALUE_CARD_ID, `T1 portfolio-value preflight cardId mismatch: ${jsonText(portfolioValuePreflight)}`);
      assert(portfolioValuePreflight?.isValid === true, `T1 portfolio-value preflight invalid: ${jsonText(portfolioValuePreflight)}`);
      assert(Array.isArray(portfolioValuePreflight?.issues), `T1 portfolio-value preflight issues shape invalid: ${jsonText(portfolioValuePreflight)}`);
      console.log('[T1] portfolio-value candidate preflight passed');
    }

    if (isTestSelected(requestedTests, 'T2')) {
      console.log(`\n=== T2: re-upsert ${PORTFOLIO_CARD_ID}, seed ${MARKET_PRICES_CARD_ID} + ${PORTFOLIO_VALUE_CARD_ID}, and verify total value ===`);

      const [portfolioUpsertResult, marketPricesUpsertResult, portfolioValueUpsertResult] = await Promise.all([
        callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_CARD_ID,
          candidate_card_content: portfolioT2SeedCard,
        }),
        callMcp('manage.upsert-card', {
          card_id: MARKET_PRICES_CARD_ID,
          candidate_card_content: marketPricesSeedCard,
        }),
        callMcp('manage.upsert-card', {
          card_id: PORTFOLIO_VALUE_CARD_ID,
          candidate_card_content: portfolioValueSeedCard,
        }),
      ]);

      expectMcpSuccess(portfolioUpsertResult, 'T2 manage.upsert-card portfolio with extra row');
      expectMcpSuccess(marketPricesUpsertResult, 'T2 manage.upsert-card market-prices');
      expectMcpSuccess(portfolioValueUpsertResult, 'T2 manage.upsert-card portfolio-value');
      createdCardIds.push(PORTFOLIO_CARD_ID, MARKET_PRICES_CARD_ID, PORTFOLIO_VALUE_CARD_ID);
      console.log('[T2] portfolio card re-upserted with additional holding row');
      console.log('[T2] market-prices card upserted');
      console.log('[T2] portfolio-value card upserted');

      const t1Poll = await pollBoardStatus(callMcp, 10, 1000, (statusData) => {
        const marketCard = findBoardStatusCard(statusData, MARKET_PRICES_CARD_ID);
        const portfolioValueCard = findBoardStatusCard(statusData, PORTFOLIO_VALUE_CARD_ID);
        return marketCard
          && portfolioValueCard
          && String(marketCard.status || '') === 'completed'
          && String(portfolioValueCard.status || '') === 'completed';
      }, 'dependent cards to complete');
      assert(
        t1Poll.matched,
        `T2 timed out waiting for dependent cards to complete: ${jsonText(t1Poll.statusData)}`,
      );
      console.log(`[T2] dependent cards completed in ${t1Poll.attemptsUsed} poll(s)`);

      const storedPortfolio = readStoredCard(
        expectMcpSuccess(
          await callMcp('manage.read-card', { card_id: PORTFOLIO_CARD_ID }),
          'T2 manage.read-card portfolio',
        ),
      );
      const marketRuntime = expectMcpSuccess(
        await callMcp('inspect.card-definition-and-runtime', { card_id: MARKET_PRICES_CARD_ID }),
        'T2 inspect.card-definition-and-runtime market-prices',
      );
      const portfolioValueRuntime = expectMcpSuccess(
        await callMcp('inspect.card-definition-and-runtime', { card_id: PORTFOLIO_VALUE_CARD_ID }),
        'T2 inspect.card-definition-and-runtime portfolio-value',
      );

      const holdings = storedPortfolio?.card_data?.holdings;
      const priceRows = marketRuntime?.runtime_data?.computed_values?.prices
        || marketRuntime?.runtime_data?.computed_values?.normalizedQuotes?.quoteResponse?.result
        || [];
      const positions = portfolioValueRuntime?.runtime_data?.computed_values?.positions;
      const totalValue = Number(portfolioValueRuntime?.runtime_data?.computed_values?.totalValue);

      assert(Array.isArray(holdings) && holdings.length > 0, 'T2 holdings missing from stored portfolio card');
      assert(Array.isArray(priceRows) && priceRows.length > 0, 'T2 market-prices runtime rows missing');
      assert(Array.isArray(positions) && positions.length > 0, 'T2 portfolio-value positions missing');
      assert(Number.isFinite(totalValue), 'T2 portfolio-value totalValue missing');

      const expectedTotal = computeExpectedPortfolioValue(holdings, priceRows);
      assert(
        roundMoney(totalValue) === expectedTotal,
        `T2 totalValue mismatch: expected ${expectedTotal}, got ${roundMoney(totalValue)}`,
      );
      console.log(`[T2] total portfolio value verified: ${expectedTotal}`);
    }

    if (isTestSelected(requestedTests, 'TQ')) {
      console.log(`\n=== TQ: enqueue process-accumulated and verify queue runner drains it ===`);

      const wakeup = await enqueueProcessAccumulatedWakeup(BOARD_ID);
      console.log(`[TQ] enqueued process-queue message ${wakeup.id}`);

      let drained = false;
      let attemptsUsed = 0;
      let lastQueueDoc = null;
      let sawLease = false;
      const progress = createPollProgress(`process-queue message ${wakeup.id} to drain`);
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        attemptsUsed = attempt;
        progress.tick();
        lastQueueDoc = await readProcessAccumulatedWakeup(BOARD_ID, wakeup.id);
        if (!lastQueueDoc) {
          drained = true;
          break;
        }
        if (lastQueueDoc.dead === true) {
          break;
        }
        if (lastQueueDoc.leaseToken) {
          sawLease = true;
        }
        await sleep(500);
      }
      progress.done();

      assert(
        drained,
        lastQueueDoc?.dead === true
          ? `TQ process-queue wakeup dead-lettered instead of draining: ${jsonText(lastQueueDoc)}`
          : sawLease
            ? `TQ process-queue wakeup was leased by queue runner but not acked before timeout: ${jsonText(lastQueueDoc)}`
          : `TQ process-queue wakeup was not drained by queue runner: ${jsonText(lastQueueDoc)}`,
      );
      console.log(`[TQ] queue runner drained process-queue message in ${attemptsUsed} poll(s)`);
    }

    console.log('\n=== Selected tests passed ===\n');
  } finally {
    for (const cardId of [...new Set(createdCardIds)].reverse()) {
      try {
        const removeResult = await callMcp('manage.remove-card', { card_id: cardId });
        if (removeResult.status === 200 && removeResult.data?.status === 'success') {
          console.log(`[cleanup] removed ${cardId}`);
        } else {
          console.error(`[cleanup] remove-card failed for ${cardId}: ${jsonText(removeResult.data)}`);
        }
      } catch (error) {
        console.error(`[cleanup] remove-card errored for ${cardId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await cleanupHostedFirebaseContext();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
