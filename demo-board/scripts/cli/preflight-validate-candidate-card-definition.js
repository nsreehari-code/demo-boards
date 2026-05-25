#!/usr/bin/env node

import {
  isHelpRequested,
  parseArgs,
  printJson,
  printUsage,
  readCandidateCardPayload,
  runBoardLiveCardsCli,
} from './preflight-candidate-card-common.js';

const usageLines = [
  'Usage:',
  '  cat payload.json | node preflight-validate-candidate-card-definition.js',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card> }',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const payload = readCandidateCardPayload(usageLines);
  const result = runBoardLiveCardsCli('validate-card-preflight', [], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
