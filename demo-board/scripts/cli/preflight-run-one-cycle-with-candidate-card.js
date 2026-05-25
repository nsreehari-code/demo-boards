#!/usr/bin/env node

import {
  isHelpRequested,
  parseArgs,
  printJson,
  printUsage,
  readCandidateCardPayload,
  requireArgText,
  runSiblingScript,
} from './preflight-candidate-card-common.js';

const usageLines = [
  'Usage:',
  '  cat payload.json | node preflight-run-one-cycle-with-candidate-card.js --base-ref <board-ref>',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card>, "mock_requires": {...} }',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const baseRef = requireArgText(args, 'base-ref', usageLines);
  const payload = readCandidateCardPayload(usageLines, ['mock_requires']);
  const result = runSiblingScript('run-one-card-cycle.js', ['--base-ref', baseRef], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
