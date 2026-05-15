import { askWorkiq } from './handlers/workiq.js';
import { handleFinbookTool } from './handlers/finbook.js';
import { handleTeamsGraph } from './handlers/teams.js';

async function notImplemented(args, tool) {
  throw new Error(`Handler ${tool.handler} is not implemented yet`);
}

const HANDLERS = {
  'finbook': handleFinbookTool,
  'finbook.api': handleFinbookTool,
  'teams.graph': handleTeamsGraph,
  'workiq.ask': askWorkiq,
  'repo.export': notImplemented,
  'repo.query': notImplemented,
};

export function resolveHandler(handlerId) {
  const handler = HANDLERS[handlerId];
  if (!handler) {
    throw new Error(`Unknown MCP handler: ${handlerId}`);
  }
  return handler;
}
