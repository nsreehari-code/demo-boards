#!/usr/bin/env node

import {
  isHelpRequested,
  parseArgs,
  printJson,
  printUsage,
  readCandidateCardPayload,
  runSiblingScript,
} from './preflight-candidate-card-common.js';

const usageLines = [
  'Usage:',
  '  cat payload.json | node preflight-materialize-candidate-card.js',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card>, "mock_requires": {...}, "mock_fetched_sources": {...} }',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const payload = readCandidateCardPayload(usageLines, ['mock_requires', 'mock_fetched_sources']);
  const result = runSiblingScript('materialize-live-card.js', [], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
