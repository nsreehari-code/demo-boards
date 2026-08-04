import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createFilesystemSnapshotInvalidationWatcher,
  FILESYSTEM_SNAPSHOT_INVALIDATION_NOTIFICATION,
} from '../src/filesystem-snapshot-invalidations.js';

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

test('filesystem watcher publishes debounced runtime snapshot invalidations', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'gik-invalidations-'));
  const received = [];
  const watcher = createFilesystemSnapshotInvalidationWatcher({
    rootDir,
    debounceMs: 10,
    publish: (invalidation) => received.push(invalidation),
  });
  try {
    await watcher.ready;
    const stateDirectory = path.join(rootDir, 'board-1', 'kv');
    const stateFile = path.join(stateDirectory, '__gik_runtime_state__.json');
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(stateFile, JSON.stringify({ runtimeId: 'board/v1', revision: 'revision-1' }));
    await writeFile(stateFile, JSON.stringify({ runtimeId: 'board/v1', revision: 'revision-2' }));

    await eventually(() => assert.equal(received.length, 1));
    assert.equal(received[0].runtimeId, 'board/v1');
    assert.equal(received[0].observedRevision, 'revision-2');
    assert.match(received[0].stateRef, /^b64:/);
    assert.equal(
      JSON.parse(Buffer.from(received[0].stateRef.slice(4), 'base64url')).value,
      path.join(rootDir, 'board-1'),
    );
    assert.equal(
      FILESYSTEM_SNAPSHOT_INVALIDATION_NOTIFICATION,
      'notifications/gik/runtime_snapshot_invalidated',
    );
  } finally {
    await watcher.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
