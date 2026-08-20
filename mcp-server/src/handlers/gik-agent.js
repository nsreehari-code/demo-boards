import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCapabilityDescribeTool } from '@gik/agent-lifecycle-exp';

const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultCatalogPath = path.join(
  mcpServerRoot,
  '.copilot-workspace',
  '.gik',
  'capability-catalog.json',
);

function loadCatalog(tool) {
  const configuredPath = typeof tool?.config?.catalogPath === 'string'
    ? tool.config.catalogPath.trim()
    : '';
  const catalogPath = path.resolve(
    mcpServerRoot,
    configuredPath || process.env.GIK_CAPABILITY_CATALOG || defaultCatalogPath,
  );
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`GIK capability catalog not found at ${catalogPath}; reprovision the Copilot workspace`);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!catalog || typeof catalog.catalog !== 'object' || typeof catalog.details !== 'object') {
    throw new Error(`GIK capability catalog at ${catalogPath} is invalid`);
  }
  return catalog;
}

export async function handleGikAgentTool(args, tool) {
  if (tool.name !== 'describe') {
    throw new Error(`Unsupported GIK agent tool '${tool.name}'`);
  }
  const describe = createCapabilityDescribeTool(loadCatalog(tool));
  const result = await describe.handler(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}
