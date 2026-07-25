import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilesystemToolHandler } from '../src/handlers/filesystem.js';

test('filesystem MCP tools create refs and run ordered storage batches', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-handler-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const handler = createFilesystemToolHandler({ rootDir });

  const created = await handler({ namespace: 'board-one' }, { name: 'filesystem.create_ref' });
  const ref = created.structuredContent.ref;
  assert.match(ref, /^b64:/);

  const response = await handler({
    operations: [
      { ref, capability: 'kv', operation: 'write', args: ['state', { count: 1 }] },
      { ref, capability: 'kv', operation: 'read', args: ['state'] },
      { ref, capability: 'journal', operation: 'append', args: [{ type: 'created' }] },
      { ref, capability: 'journal', operation: 'readAll' },
    ],
  }, { name: 'filesystem.storage_batch' });

  const results = response.structuredContent.results;
  assert.equal(results.length, 4);
  assert.ok(results.every((entry) => entry.ok));
  assert.deepEqual(results[1].result, { count: 1 });
  assert.equal(results[3].result.length, 1);
  assert.deepEqual(results[3].result[0].payload, { type: 'created' });

  const acquired = await handler({ operations: [
    { ref, capability: 'lock', operation: 'acquire' },
    { ref, capability: 'lock', operation: 'acquire' },
  ] }, { name: 'filesystem.storage_batch' });
  const token = acquired.structuredContent.results[0].result;
  assert.equal(typeof token, 'string');
  assert.equal(acquired.structuredContent.results[1].result, null);
  const released = await handler({ operations: [
    { ref, capability: 'lock', operation: 'release', args: [token] },
  ] }, { name: 'filesystem.storage_batch' });
  assert.equal(released.structuredContent.results[0].result, true);
});

test('filesystem batch isolates operation failures and continues in order', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-handler-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const handler = createFilesystemToolHandler({ rootDir });
  const { ref } = (await handler({ namespace: 'board-two' }, { name: 'filesystem.create_ref' })).structuredContent;
  const response = await handler({ operations: [
    { ref, capability: 'kv', operation: 'unsupported' },
    { ref, capability: 'kv', operation: 'write', args: ['after-error', true] },
    { ref, capability: 'kv', operation: 'read', args: ['after-error'] },
  ] }, { name: 'filesystem.storage_batch' });
  assert.equal(response.structuredContent.results[0].ok, false);
  assert.equal(response.structuredContent.results[1].ok, true);
  assert.equal(response.structuredContent.results[2].result, true);
});