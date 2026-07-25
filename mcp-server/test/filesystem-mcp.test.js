import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverRoot = path.resolve(import.meta.dirname, '..');

test('filesystem tools persist storage through the MCP stdio transport', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-e2e-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/index.js', '--transport', 'stdio', '--manifest', 'manifests/demo-boards.filesystem.json'],
    cwd: serverRoot,
    env: { ...process.env, DEMO_BOARDS_FILESYSTEM_STORAGE_ROOT: rootDir },
  });
  const client = new Client({ name: 'filesystem-test-client', version: '0.1.0' });
  t.after(async () => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'filesystem.create_ref',
    'filesystem.storage_batch',
  ]);

  const created = await client.callTool({
    name: 'filesystem.create_ref',
    arguments: { namespace: 'stdio-board' },
  });
  const ref = created.structuredContent.ref;
  const batch = await client.callTool({
    name: 'filesystem.storage_batch',
    arguments: {
      operations: [
        { ref, capability: 'kv', operation: 'write', args: ['state', { count: 7 }] },
        { ref, capability: 'kv', operation: 'read', args: ['state'] },
      ],
    },
  });
  assert.deepEqual(batch.structuredContent.results, [
    { ok: true, result: null },
    { ok: true, result: { count: 7 } },
  ]);
});