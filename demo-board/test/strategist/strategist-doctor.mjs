#!/usr/bin/env node
// Layer A — StrategistDoctor: static lint of the Journey Strategist setup.
//
// Deterministic, no LLM, no server, no writes. Catches the structural mistakes
// that would silently degrade the strategist before any live run:
//   1. journey-strategist card integrity (token wiring, compute<->source bindTo,
//      prompt placeholders resolve, status/move enums consistent with the badge).
//   2. Three-tier instruction stack materializes (base agent + generic engine +
//      board-local domain pack) and the soul skill is present.
//   3. Tier purity — the SHARED engine tier carries NO board-specific domain
//      vocabulary, while each board's domain pack DOES carry its own.
//   4. Every markdown file link in the materialized copilot-instructions.md
//      resolves to a file that materialization actually places on disk
//      (this is the check that catches the soul-reference path bug).
//
// Usage:
//   node strategist-doctor.mjs [boardId ...]
// With no args it lints every board whose uiTemplate is "journeys".
// Exit code 0 = all checks pass, 1 = at least one failure.

import {
  loadTemplatesConfig,
  loadHostConfig,
  listJourneyBoards,
  getStemEntry,
  concatInstructions,
  materializedGithubPaths,
  getStrategistCard,
  extractPromptEnum,
  extractPlaceholders,
  extractFileLinks,
  resolveDir,
  listFilesShallow,
  STATUS_VALUES,
  MOVE_VALUES,
} from './lib/strategist-harness-lib.mjs';
import fs from 'node:fs';

const STEM = 'strategist';

// Generic engine doctrine markers that must survive materialization.
const ENGINE_MARKERS = [
  'The Journey Strategist Engine',
  'truthset',
  'Deepen',
  'Broaden',
  'Clarify',
  'Reconcile',
  'Hold steady',
];

// Base agent-instructions markers.
const BASE_MARKERS = [
  'Agent Instructions',
  'The Card Is The First-Class Citizen',
];

// Words that betray a specific board's domain. The SHARED engine tier
// (chat-flow/instructions-strategist) must contain none of these; a board's
// own domain pack is expected to contain its matching set.
const DOMAIN_VOCAB = {
  investigate: ['threat-hunting', 'sign-in', 'kusto', 'blast radius', 'analyst', 'hypothesis'],
  trip: ['itinerary', 'destination', 'booking', 'traveler', 'lodging'],
};

let hadFailure = false;
const log = (s = '') => process.stdout.write(`${s}\n`);
function check(label, ok, detail = '') {
  if (ok) {
    log(`  PASS  ${label}`);
  } else {
    hadFailure = true;
    log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function lintCard(card) {
  log('\n[card] journey-strategist integrity');
  if (!card) { check('card present in uiTemplates.journeys.admin-cards', false); return; }

  const sd = (card.source_defs || [])[0] || {};
  const bindTo = sd.bindTo;
  check('source_def[0].bindTo present', !!bindTo, 'missing bindTo');
  check('source_def[0].outputFile present', !!sd.outputFile);

  const shape = sd.copilot?.result_shape || {};
  for (const k of ['status', 'move', 'rationale', 'created_cards', 'updated_cards', 'next_candidates']) {
    check(`result_shape has "${k}"`, Object.prototype.hasOwnProperty.call(shape, k));
  }

  // compute exprs must reference fetched_sources.<bindTo>
  const computes = card.compute || [];
  const computeBindTos = new Set(computes.map((c) => c.bindTo));
  const refRe = new RegExp(`fetched_sources\\.${bindTo}\\b`);
  const computeRefsOk = computes
    .filter((c) => /fetched_sources\./.test(c.expr || ''))
    .every((c) => refRe.test(c.expr));
  check(`all compute exprs reference fetched_sources.${bindTo}`, computeRefsOk,
    'a compute expr references a different source bindTo');

  // provides ref must point at a real computed value
  const provide = (card.provides || [])[0] || {};
  const provideRef = (provide.ref || '').replace('computed_values.', '');
  check('provides[0].ref points at a real compute bindTo',
    computeBindTos.has(provideRef), `provides ref "${provide.ref}" has no matching compute`);

  // prompt placeholders must all be supplied by projections (or boardId)
  const prompt = sd.copilot?.prompt_template || '';
  const projections = Object.keys(sd.projections || {});
  const allowed = new Set([...projections, 'boardId']);
  const dangling = extractPlaceholders(prompt).filter((p) => !allowed.has(p));
  check('no dangling {{placeholders}} in prompt_template', dangling.length === 0,
    `unresolved: ${dangling.join(', ')}`);

  // status/move enums consistent between prompt and the badge colorMap
  const statusEnum = extractPromptEnum(prompt, 'status') || [];
  const moveEnum = extractPromptEnum(prompt, 'move') || [];
  check('prompt status enum matches canonical', sameSet(statusEnum, STATUS_VALUES),
    `prompt=[${statusEnum}] expected=[${STATUS_VALUES}]`);
  check('prompt move enum matches canonical', sameSet(moveEnum, MOVE_VALUES),
    `prompt=[${moveEnum}] expected=[${MOVE_VALUES}]`);

  const badge = (card.view?.elements || []).find((e) => e.kind === 'badge');
  const colorKeys = Object.keys(badge?.data?.colorMap || {}).filter((k) => k !== 'idle');
  check('badge colorMap keys match status enum (minus idle)',
    sameSet(colorKeys, STATUS_VALUES), `badge=[${colorKeys}] expected=[${STATUS_VALUES}]`);
}

function lintBoard(templatesConfig, board) {
  const boardId = board.id;
  const aiTemplate = board.cfg.aiWorkspaceTemplate || 'default';
  log(`\n=== board: ${boardId} (aiWorkspaceTemplate=${aiTemplate}) ===`);

  const entry = getStemEntry(templatesConfig, aiTemplate, STEM);
  if (!entry) { check(`"${STEM}" stem defined in ai-workdirs-setup`, false); return; }
  check(`"${STEM}" stem defined in ai-workdirs-setup`, true);

  const { text, sourceFiles } = concatInstructions(entry, boardId);
  check('copilot-instructions.md would be non-empty', text.length > 0);

  // 1. three tiers present
  for (const marker of BASE_MARKERS) check(`base tier marker present: "${marker}"`, text.includes(marker));
  for (const marker of ENGINE_MARKERS) check(`engine tier marker present: "${marker}"`, text.includes(marker));

  // domain pack: board-local instructions dir must contribute at least one file
  const domainDir = resolveDir(`{{BOARD_ROOT}}/boards/${boardId}/copilot/strategist/instructions`, boardId);
  const domainFiles = listFilesShallow(domainDir);
  check('board-local domain pack contributes >=1 instruction file', domainFiles.length > 0,
    `no files in boards/${boardId}/copilot/strategist/instructions`);
  if (domainFiles.length > 0) {
    const domainText = domainFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    check('domain pack content is included in materialized instructions',
      text.includes(domainText.trim().slice(0, 40)));
    const vocab = DOMAIN_VOCAB[boardId] || [];
    if (vocab.length) {
      const present = vocab.filter((w) => new RegExp(w, 'i').test(domainText));
      check(`domain pack carries its own vocabulary (${present.length}/${vocab.length})`,
        present.length > 0, `none of: ${vocab.join(', ')}`);
    }
  }

  // 2. tier purity — shared engine must not leak ANY board's domain vocabulary
  const engineDir = resolveDir('{{BOARD_ROOT}}/server/chat-flow/instructions-strategist', boardId);
  const engineText = listFilesShallow(engineDir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const leaks = [];
  for (const [dom, words] of Object.entries(DOMAIN_VOCAB)) {
    for (const w of words) if (new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(engineText)) leaks.push(`${dom}:${w}`);
  }
  check('shared engine tier is domain-free (no board vocabulary leaks)', leaks.length === 0,
    `leaked: ${leaks.join(', ')}`);

  // 3. soul skill present
  const githubPaths = materializedGithubPaths(entry, boardId);
  check('soul skill materializes at .github/skills/live-board-cards-soul.md',
    githubPaths.has('.github/skills/live-board-cards-soul.md'));

  // 4. every file link in the instructions resolves to a materialized path
  const links = extractFileLinks(text);
  const broken = links.filter((l) => !githubPaths.has(l.replace(/^\.\//, '')));
  check(`all ${links.length} markdown file link(s) resolve to a materialized file`,
    broken.length === 0, `broken: ${broken.join(', ')}`);
}

function sameSet(a, b) {
  const sa = new Set(a); const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function main() {
  const templatesConfig = loadTemplatesConfig();
  const hostConfig = loadHostConfig();
  const argv = process.argv.slice(2);
  const boards = argv.length
    ? argv.map((id) => ({ id, cfg: (hostConfig['bootstrap-sample-boards'] || {})[id] || { aiWorkspaceTemplate: 'default', uiTemplate: 'journeys' } }))
    : listJourneyBoards(hostConfig);

  if (boards.length === 0) { log('No journey boards found (uiTemplate=journeys).'); process.exit(1); }

  log('StrategistDoctor — static lint (Layer A)');
  lintCard(getStrategistCard(templatesConfig));
  for (const board of boards) lintBoard(templatesConfig, board);

  log('');
  if (hadFailure) { log('RESULT: FAIL'); process.exit(1); }
  log('RESULT: PASS');
}

main();
