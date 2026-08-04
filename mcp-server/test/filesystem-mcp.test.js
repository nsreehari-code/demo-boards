import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRuntimeSnapshotChanges } from '@gik/durable-runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

const serverRoot = path.resolve(import.meta.dirname, '..');
const snapshotInvalidationNotificationSchema = NotificationSchema.extend({
  method: z.literal('notifications/gik/runtime_snapshot_invalidated'),
  params: z.object({
    runtimeId: z.string(),
    stateRef: z.string(),
    observedRevision: z.string().optional(),
  }),
});

async function eventually(assertion, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assertion();
}

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
  const invalidations = [];
  client.setNotificationHandler(snapshotInvalidationNotificationSchema, (notification) => {
    invalidations.push(notification.params);
  });
  t.after(async () => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'filesystem.create_ref',
    'filesystem.effect_ack',
    'filesystem.effect_lease',
    'filesystem.effect_nack',
    'filesystem.engine_wake_processed',
    'filesystem.engine_wake_read',
    'filesystem.journal_append_and_wake',
    'filesystem.runtime_initialize',
    'filesystem.runtime_snapshot',
    'filesystem.runtime_snapshot_changes',
    'filesystem.storage_batch',
    'filesystem.transition_abort',
    'filesystem.transition_acquire',
    'filesystem.transition_commit',
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

  await client.callTool({
    name: 'filesystem.journal_append_and_wake',
    arguments: {
      stateRef: ref, journalRef: ref, effectsQueueRef: ref,
      entry: { type: 'increment' },
    },
  });
  const wake = await client.callTool({
    name: 'filesystem.engine_wake_read',
    arguments: { stateRef: ref, effectsQueueRef: ref },
  });
  assert.equal(typeof wake.structuredContent.wake.requestedAt, 'string');
  const initialized = await client.callTool({
    name: 'filesystem.runtime_initialize',
    arguments: {
      stateRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime', initialState: { count: 0 }, initialSpec: { multiplier: 1 },
    },
  });
  assert.equal(initialized.structuredContent.initialization.created, true);
  const acquired = await client.callTool({
    name: 'filesystem.transition_acquire',
    arguments: {
      stateRef: ref, journalRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime',
    },
  });
  assert.equal(acquired.structuredContent.transition.entries.length, 1);
  const snapshot = await client.callTool({
    name: 'filesystem.runtime_snapshot',
    arguments: {
      stateRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime',
    },
  });
  assert.deepEqual(snapshot.structuredContent.snapshot, {
    state: { count: 0 },
    spec: { multiplier: 1 },
    revision: acquired.structuredContent.transition.revision,
  });
  const changes = await client.callTool({
    name: 'filesystem.runtime_snapshot_changes',
    arguments: {
      stateRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime', afterRevision: acquired.structuredContent.transition.revision,
    },
  });
  assert.deepEqual(changes.structuredContent.changes, {
    kind: 'unchanged', revision: acquired.structuredContent.transition.revision,
  });
  const committed = await client.callTool({
    name: 'filesystem.transition_commit',
    arguments: {
      stateRef: ref, journalRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime', leaseToken: acquired.structuredContent.transition.leaseToken,
      expectedRevision: acquired.structuredContent.transition.revision, previousCursor: null,
      nextCursor: acquired.structuredContent.transition.entries[0].id,
      state: { count: 1 }, spec: { multiplier: 2 },
      specUpdates: [{ multiplier: 2 }], effects: [],
    },
  });
  assert.equal(committed.structuredContent.ok, true);
  await eventually(() => assert.ok(invalidations.some((invalidation) =>
    invalidation.runtimeId === 'stdio-runtime'
      && invalidation.stateRef === ref
      && invalidation.observedRevision === committed.structuredContent.revision)));
  const committedChanges = await client.callTool({
    name: 'filesystem.runtime_snapshot_changes',
    arguments: {
      stateRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime', afterRevision: acquired.structuredContent.transition.revision,
    },
  });
  assert.equal(committedChanges.structuredContent.changes.kind, 'changes');
  assert.deepEqual(applyRuntimeSnapshotChanges({
    state: { count: 0 },
    spec: { multiplier: 1 },
    revision: acquired.structuredContent.transition.revision,
  }, committedChanges.structuredContent.changes), {
    state: { count: 1 },
    spec: { multiplier: 2 },
    revision: committed.structuredContent.revision,
  });
  await client.callTool({
    name: 'filesystem.engine_wake_processed',
    arguments: {
      stateRef: ref, effectsQueueRef: ref,
      processedAt: wake.structuredContent.wake.requestedAt,
    },
  });
  const next = await client.callTool({
    name: 'filesystem.transition_acquire',
    arguments: {
      stateRef: ref, journalRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime',
    },
  });
  const aborted = await client.callTool({
    name: 'filesystem.transition_abort',
    arguments: {
      stateRef: ref, journalRef: ref, effectsQueueRef: ref,
      runtimeId: 'stdio-runtime', leaseToken: next.structuredContent.transition.leaseToken,
    },
  });
  assert.equal(aborted.structuredContent.aborted, true);
});