#!/usr/bin/env node
// Live smoke test for the kusto.* MCP tools.
//
// Invokes the registered handler directly (no MCP transport) against the
// configured Azure Data Explorer cluster/database. Verifies three things:
//   1. auth + connectivity  -> kusto.query with `print test=1`
//   2. database access       -> kusto.list_tables
//   3. schema read           -> kusto.get_schema on the first listed table
//
// Auth uses the local Azure CLI (az). Run `az login` first if needed.
// Override target with KUSTO_CLUSTER_URI / KUSTO_DATABASE / KUSTO_TENANT_ID.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleKustoTool } from '../src/handlers/kusto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpServerRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(mcpServerRoot, 'manifests', 'kusto.local.json');

// Load mcp-server/.env so KUSTO_* overrides resolve, matching src/index.js.
const envPath = path.join(mcpServerRoot, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore malformed .env; explicit environment variables still take effect.
  }
}

function loadManifestTools() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  return new Map(tools.map((tool) => [tool.name, { ...tool, manifestPath }]));
}

async function invoke(tools, name, args) {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool not found in manifest: ${name}`);
  }
  const result = await handleKustoTool(args, tool);
  return result.structuredContent;
}

function logEnvelope(label, envelope) {
  if (envelope?.ok) {
    console.log(`  [ok]  ${label}`);
  } else {
    console.log(`  [FAIL] ${label}: ${envelope?.error?.message || 'unknown error'}`);
  }
  return envelope?.ok === true;
}

async function main() {
  const tools = loadManifestTools();
  console.log('[kusto:smoke] target:', {
    cluster: process.env.KUSTO_CLUSTER_URI || 'https://kendradatasets.eastus.kusto.windows.net (default)',
    database: process.env.KUSTO_DATABASE || 'codeboxTesting (default)',
  });

  let allOk = true;

  // 1. auth + connectivity
  const ping = await invoke(tools, 'kusto.query', { query: 'print test=1' });
  allOk = logEnvelope('kusto.query  print test=1', ping) && allOk;
  if (ping?.ok) {
    console.log('         ->', JSON.stringify(ping.data.rows));
  }

  // 2. database access
  const list = await invoke(tools, 'kusto.list_tables', {});
  allOk = logEnvelope('kusto.list_tables', list) && allOk;
  let firstTable = '';
  if (list?.ok) {
    firstTable = list.data.tables[0] || '';
    console.log(`         -> ${list.data.tableCount} tables: ${list.data.tables.slice(0, 15).join(', ')}${list.data.tables.length > 15 ? ', …' : ''}`);
  }

  // 3. schema read (only if we discovered a table)
  if (firstTable) {
    const schema = await invoke(tools, 'kusto.get_schema', { table: firstTable });
    allOk = logEnvelope(`kusto.get_schema  ${firstTable}`, schema) && allOk;
    if (schema?.ok) {
      console.log('         ->', String(schema.data.schema).slice(0, 200));
    }
  }

  console.log(allOk ? '[kusto:smoke] PASS' : '[kusto:smoke] FAIL');
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`[kusto:smoke] ${String(error?.stack || error?.message || error)}`);
  process.exit(1);
});
