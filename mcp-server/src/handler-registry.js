import { askWorkiq } from './handlers/workiq.js';
import { handleFinbookTool } from './handlers/finbook.js';
import { handleLoreTool } from './handlers/lore.js';
import { handleTeamsGraph } from './handlers/teams.js';
import { handleRemoteMcpTool } from './handlers/mcp-proxy.js';
import { handleSentinelLogin } from './handlers/sentinel-auth.js';
import { handleKustoTool } from './handlers/kusto.js';

async function notImplemented(args, tool) {
  throw new Error(`Handler ${tool.handler} is not implemented yet`);
}

const HANDLERS = {
  'finbook': handleFinbookTool,
  'finbook.api': handleFinbookTool,
  'kusto': handleKustoTool,
  'lore': handleLoreTool,
  'mcp.proxy': handleRemoteMcpTool,
  'sentinel.login': handleSentinelLogin,
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
