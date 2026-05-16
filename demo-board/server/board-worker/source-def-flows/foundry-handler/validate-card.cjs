#!/usr/bin/env node
/**
 * validate-card.cjs — Validate a card JSON file via board-live-cards CLI.
 * Uses the `validate-tmp-card` subcommand which runs schema validation,
 * JSONata syntax checks, and provides-ref namespace validation.
 * Usage: node validate-card.cjs <path-to-card.json>
 * Outputs JSON: { ok: boolean, errors: string[] }
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) {
  console.log(JSON.stringify({ ok: false, errors: ['Usage: validate-card.cjs <card.json>'] }));
  process.exit(1);
}

function resolveBoardLiveCardsBin() {
  try {
    const yamlFlowPkg = require.resolve('yaml-flow/package.json');
    const nodeModulesDir = path.dirname(path.dirname(yamlFlowPkg));
    const binName = process.platform === 'win32' ? 'board-live-cards.cmd' : 'board-live-cards';
    return path.join(nodeModulesDir, '.bin', binName);
  } catch {
    return null;
  }
}

try {
  const cardJson = fs.readFileSync(filePath, 'utf-8');
  const cliBin = resolveBoardLiveCardsBin();
  if (!cliBin) {
    throw new Error('Cannot resolve board-live-cards CLI');
  }
  const stdout = execFileSync(cliBin, ['validate-tmp-card'], {
    input: cardJson,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(stdout);
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    console.log(JSON.stringify({
      ok: data.isValid !== false,
      errors: data.issues || [],
    }));
  } else {
    console.log(JSON.stringify({ ok: false, errors: [parsed.error || 'validation failed'] }));
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, errors: [err.message || String(err)] }));
}