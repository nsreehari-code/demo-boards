#!/usr/bin/env node
// Layer B — strategist move-contract validator.
//
// Validates a strategist "move" (the journey-strategist-move.json the copilot
// source emits) against the board contract and a board snapshot, deterministically
// and without an LLM. This is the strategist analog of SmokeRunner's deterministic
// cases: given a known move + known board state, the pass/fail outcome is fixed.
//
// Usage:
//   node validate-move.mjs <move.json> [--board <board-snapshot.json>]
//   node validate-move.mjs --selftest
//
// --selftest proves the validator discriminates: the golden move must PASS and
// the bad move must FAIL. Exit 0 = ok, 1 = contract violation / selftest mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMove } from './lib/strategist-harness-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const log = (s = '') => process.stdout.write(`${s}\n`);

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function snapshotToBoardState(snap) {
  return { cardIds: snap.cardIds || [], policy: snap.policy || {} };
}

function report(label, move, boardState, { expect } = {}) {
  const res = validateMove(move, boardState);
  log(`\n[${label}]`);
  for (const e of res.errors) log(`  ERROR    ${e}`);
  for (const w of res.warnings) log(`  warning  ${w}`);
  log(`  -> ${res.ok ? 'PASS' : 'FAIL'} (${res.errors.length} error(s), ${res.warnings.length} warning(s))`);
  if (expect !== undefined && res.ok !== expect) {
    log(`  !! expected ${expect ? 'PASS' : 'FAIL'} but got ${res.ok ? 'PASS' : 'FAIL'}`);
    return { res, expectationMet: false };
  }
  return { res, expectationMet: true };
}

function selftest() {
  log('Move-contract validator — self test (Layer B)');
  const board = snapshotToBoardState(loadJson(path.join(FIX, 'board-snapshot.investigate.json')));
  const golden = report('golden move (expect PASS)', loadJson(path.join(FIX, 'golden-move.deepen.json')), board, { expect: true });
  const bad = report('bad move (expect FAIL)', loadJson(path.join(FIX, 'bad-move.json')), board, { expect: false });
  const ok = golden.expectationMet && bad.expectationMet;
  log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const movePath = argv.find((a) => !a.startsWith('--'));
  if (!movePath) {
    log('Usage: node validate-move.mjs <move.json> [--board <snapshot.json>] | --selftest');
    process.exit(2);
  }
  const boardIdx = argv.indexOf('--board');
  const boardPath = boardIdx >= 0 ? argv[boardIdx + 1] : path.join(FIX, 'board-snapshot.investigate.json');
  const board = snapshotToBoardState(loadJson(boardPath));
  const { res } = report(path.basename(movePath), loadJson(movePath), board);
  process.exit(res.ok ? 0 : 1);
}

main();
