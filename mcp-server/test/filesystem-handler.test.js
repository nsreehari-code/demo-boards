import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRuntimeSnapshotChanges } from '@gik/durable-runtime';

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

test('filesystem journal preserves concurrent semantic appends without locking', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-journal-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const handler = createFilesystemToolHandler({ rootDir });
  const { ref } = (await handler({ namespace: 'concurrent-journal' }, { name: 'filesystem.create_ref' })).structuredContent;

  await Promise.all(Array.from({ length: 32 }, (_, index) => handler({
    stateRef: ref,
    journalRef: ref,
    effectsQueueRef: ref,
    entry: { index },
  }, { name: 'filesystem.journal_append_and_wake' })));

  const response = await handler({ operations: [
    { ref, capability: 'journal', operation: 'readAll' },
  ] }, { name: 'filesystem.storage_batch' });
  const entries = response.structuredContent.results[0].result;
  assert.equal(entries.length, 32);
  assert.deepEqual(entries.map((entry) => entry.payload.index).sort((left, right) => left - right),
    Array.from({ length: 32 }, (_, index) => index));
  const wake = (await handler({
    stateRef: ref, effectsQueueRef: ref,
  }, { name: 'filesystem.engine_wake_read' })).structuredContent.wake;
  assert.equal(typeof wake.requestedAt, 'string');
});

test('filesystem transition tools hold the lock through commit and release it', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-transition-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const handler = createFilesystemToolHandler({ rootDir });
  const { ref } = (await handler({ namespace: 'runtime' }, { name: 'filesystem.create_ref' })).structuredContent;
  const request = {
    stateRef: ref, journalRef: ref, effectsQueueRef: ref,
    runtimeId: 'counter-v1',
  };
  const appended = (await handler({
    ...request, entry: { type: 'increment', amount: 2 },
  }, { name: 'filesystem.journal_append_and_wake' })).structuredContent.entry;
  assert.equal(typeof appended.id, 'string');
  const wake = (await handler({
    stateRef: ref, effectsQueueRef: ref,
  }, { name: 'filesystem.engine_wake_read' })).structuredContent.wake;
  assert.equal(typeof wake.requestedAt, 'string');
  assert.equal(wake.processedAt, null);
  const requestedMarker = path.join(rootDir, 'runtime', 'engine-wake-requested.file');
  const processedMarker = path.join(rootDir, 'runtime', 'engine-wake-processed.file');
  assert.equal(await fs.readFile(requestedMarker, 'utf8'), '');
  assert.equal((await fs.stat(requestedMarker)).mtime.toISOString(), wake.requestedAt);
  await assert.rejects(fs.access(path.join(rootDir, 'runtime', 'engine-wake.jsonl')), { code: 'ENOENT' });
  await assert.rejects(
    handler(request, { name: 'filesystem.transition_acquire' }),
    /Runtime is not initialized/,
  );
  const initialized = (await handler({
    stateRef: ref, effectsQueueRef: ref, runtimeId: 'counter-v1',
    initialState: { count: 0 }, initialSpec: { multiplier: 1 },
  }, { name: 'filesystem.runtime_initialize' })).structuredContent.initialization;
  assert.equal(initialized.created, true);
  assert.deepEqual((await handler({
    stateRef: ref, effectsQueueRef: ref, runtimeId: 'counter-v1',
    initialState: { count: 99 }, initialSpec: { multiplier: 99 },
  }, { name: 'filesystem.runtime_initialize' })).structuredContent.initialization, {
    created: false, revision: initialized.revision,
  });
  const acquired = (await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition;
  assert.equal(acquired.entries.length, 1);
  assert.deepEqual(acquired.spec, { multiplier: 1 });
  assert.deepEqual((await handler({
    stateRef: ref, effectsQueueRef: ref, runtimeId: 'counter-v1',
  }, { name: 'filesystem.runtime_snapshot' })).structuredContent.snapshot, {
    state: { count: 0 }, spec: { multiplier: 1 }, revision: acquired.revision,
  });
  assert.deepEqual((await handler({
    stateRef: ref, effectsQueueRef: ref, runtimeId: 'counter-v1', afterRevision: acquired.revision,
  }, { name: 'filesystem.runtime_snapshot_changes' })).structuredContent.changes, {
    kind: 'unchanged', revision: acquired.revision,
  });
  assert.equal((await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition, null);
  const committed = (await handler({
    ...request,
    leaseToken: acquired.leaseToken,
    expectedRevision: acquired.revision,
    previousCursor: acquired.cursor,
    nextCursor: acquired.entries[0].id,
    state: { count: 2 },
    spec: { multiplier: 2 },
    specUpdates: [{ multiplier: 2 }],
    effects: [{ type: 'count-changed', count: 2 }],
  }, { name: 'filesystem.transition_commit' })).structuredContent;
  assert.equal(committed.ok, true);
  const changes = (await handler({
    stateRef: ref, effectsQueueRef: ref, runtimeId: 'counter-v1', afterRevision: acquired.revision,
  }, { name: 'filesystem.runtime_snapshot_changes' })).structuredContent.changes;
  assert.equal(changes.kind, 'changes');
  assert.deepEqual(applyRuntimeSnapshotChanges({
    state: { count: 0 }, spec: { multiplier: 1 }, revision: acquired.revision,
  }, changes), {
    state: { count: 2 }, spec: { multiplier: 2 }, revision: committed.revision,
  });
  const leasedEffect = (await handler({
    effectsQueueRef: ref,
  }, { name: 'filesystem.effect_lease' })).structuredContent.message;
  assert.deepEqual(leasedEffect.body, { type: 'count-changed', count: 2 });
  assert.equal((await handler({
    effectsQueueRef: ref,
    messageId: leasedEffect.id,
    leaseToken: leasedEffect.leaseToken,
  }, { name: 'filesystem.effect_ack' })).structuredContent.acknowledged, true);
  assert.equal((await handler({
    stateRef: ref, effectsQueueRef: ref, processedAt: wake.requestedAt,
  }, { name: 'filesystem.engine_wake_processed' })).structuredContent.processed, true);
  assert.equal((await handler({
    stateRef: ref, effectsQueueRef: ref,
  }, { name: 'filesystem.engine_wake_read' })).structuredContent.wake.processedAt, wake.requestedAt);
  assert.equal(await fs.readFile(processedMarker, 'utf8'), '');
  assert.equal((await fs.stat(processedMarker)).mtime.toISOString(), wake.requestedAt);
  const next = (await handler(request, { name: 'filesystem.transition_acquire' })).structuredContent.transition;
  assert.deepEqual(next.state, { count: 2 });
  assert.deepEqual(next.spec, { multiplier: 2 });
  assert.deepEqual(next.entries, []);
  assert.equal((await handler({
    stateRef: ref, journalRef: ref, effectsQueueRef: ref,
    runtimeId: 'counter-v1', leaseToken: next.leaseToken,
  }, { name: 'filesystem.transition_abort' })).structuredContent.aborted, true);
});