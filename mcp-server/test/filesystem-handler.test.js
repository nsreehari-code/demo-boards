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

test('filesystem transition tools hold the lock through commit and release it', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-transition-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const handler = createFilesystemToolHandler({ rootDir });
  const { ref } = (await handler({ namespace: 'runtime' }, { name: 'filesystem.create_ref' })).structuredContent;
  await handler({ operations: [
    { ref, capability: 'journal', operation: 'append', args: [{ type: 'increment', amount: 2 }] },
  ] }, { name: 'filesystem.storage_batch' });
  const request = {
    stateRef: ref, journalRef: ref, effectsQueueRef: ref,
    kernelId: 'counter-v1',
  };
  await assert.rejects(
    handler(request, { name: 'filesystem.transition_acquire' }),
    /Runtime is not initialized/,
  );
  const initialized = (await handler({
    stateRef: ref, effectsQueueRef: ref, kernelId: 'counter-v1', initialState: { count: 0 },
  }, { name: 'filesystem.runtime_initialize' })).structuredContent.initialization;
  assert.equal(initialized.created, true);
  assert.deepEqual((await handler({
    stateRef: ref, effectsQueueRef: ref, kernelId: 'counter-v1', initialState: { count: 99 },
  }, { name: 'filesystem.runtime_initialize' })).structuredContent.initialization, {
    created: false, revision: initialized.revision,
  });
  const acquired = (await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition;
  assert.equal(acquired.entries.length, 1);
  assert.equal((await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition, null);
  const committed = (await handler({
    ...request,
    leaseToken: acquired.leaseToken,
    expectedRevision: acquired.revision,
    previousCursor: acquired.cursor,
    nextCursor: acquired.entries[0].id,
    state: { count: 2 },
    effects: [{ type: 'count-changed', count: 2 }],
  }, { name: 'filesystem.transition_commit' })).structuredContent;
  assert.equal(committed.ok, true);
  const next = (await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition;
  assert.deepEqual(next.state, { count: 2 });
  assert.deepEqual(next.entries, []);
  assert.equal((await handler({
    stateRef: ref, journalRef: ref, effectsQueueRef: ref,
    kernelId: 'counter-v1', leaseToken: next.leaseToken,
  }, { name: 'filesystem.transition_abort' })).structuredContent.aborted, true);
});