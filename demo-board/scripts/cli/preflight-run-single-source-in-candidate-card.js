#!/usr/bin/env node

import {
  isHelpRequested,
  parseArgs,
  printJson,
  printUsage,
  readCandidateCardPayload,
  requireArgText,
  runBoardLiveCardsCli,
} from './preflight-candidate-card-common.js';

const usageLines = [
  'Usage:',
  '  cat payload.json | node preflight-run-single-source-in-candidate-card.js --source-idx <n>',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card>, "mock_projections": {...} }',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const sourceIdx = requireArgText(args, 'source-idx', usageLines);
  const payload = readCandidateCardPayload(usageLines, ['mock_projections']);
  const result = runBoardLiveCardsCli('run-source-preflight', ['--source-idx', sourceIdx], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
