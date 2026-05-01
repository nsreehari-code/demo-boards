#!/usr/bin/env node
/**
 * validate-card.cjs — Validate a card JSON file against the live card schema.
 * Usage: node validate-card.cjs <path-to-card.json>
 * Outputs JSON: { ok: boolean, errors: string[] }
 */
const fs = require('fs');
const { validateLiveCardSchema } = require('yaml-flow');

const filePath = process.argv[2];
if (!filePath) {
  console.log(JSON.stringify({ ok: false, errors: ['Usage: validate-card.cjs <card.json>'] }));
  process.exit(1);
}

try {
  const card = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const result = validateLiveCardSchema(card);
  console.log(JSON.stringify(result));
} catch (err) {
  console.log(JSON.stringify({ ok: false, errors: [err.message || String(err)] }));
}
