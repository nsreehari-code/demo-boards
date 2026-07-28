import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFilesystemRef,
  createFilesystemStorageLibrary,
  createFsAtomicRelayLock,
  parseRef,
} from '@gik/durable-runtime/storage/filesystem/library';

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-storage-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const storage = createFilesystemStorageLibrary({ rootDir });
  const ref = storage.createRef('scope');
  return { rootDir, storage, ref };
}

test('filesystem refs are root-confined', async (t) => {
  const { rootDir, storage, ref } = await fixture(t);
  assert.equal(parseRef(ref).kind, 'fs-path');
  assert.throws(() => createFilesystemRef(rootDir, '../outside'), /escapes/);
  const escaped = Buffer.from(JSON.stringify({ kind: 'fs-path', value: path.resolve(rootDir, '..', 'outside') }))
    .toString('base64url');
  assert.throws(() => storage.kvStorageForRef(`b64:${escaped}`), /escapes/);
  assert.throws(() => storage.blobStorageForRef(ref).write('../outside', 'bad'), /escapes/);
  assert.throws(() => storage.queueStorageForRef(ref, '../outside'), /escapes/);
});

test('KV, JSON, blob, scratch, archive, and provider compose over filesystem', async (t) => {
  const { storage, ref } = await fixture(t);
  const kv = storage.kvStorageForRef(ref);
  assert.equal(await kv.read('missing'), null);
  await kv.write('cards/2', { value: 2 });
  await kv.write('cards/1', { value: 1 });
  await kv.write('cards/1', { value: 3 });
  assert.deepEqual(await kv.read('cards/1'), { value: 3 });
  assert.deepEqual(await kv.listKeys('cards/'), ['cards/1', 'cards/2']);

  const json = storage.jsonStorageForRef(ref);
  await json.write('document', { nested: { first: 1 } });
  await json.deepMerge('document', { nested: { second: 2 } });
  assert.deepEqual(await json.get('document', 'nested'), { first: 1, second: 2 });

  const blob = storage.blobStorageForRef(ref);
  await blob.write('staged/a.txt', 'hello');
  await blob.writeBytes('bytes.bin', new Uint8Array([1, 2, 3]));
  assert.equal(await blob.renameKey('staged/a.txt', 'live/a.txt'), true);
  assert.equal(await blob.read('live/a.txt'), 'hello');
  assert.deepEqual(await blob.readBytes('bytes.bin'), new Uint8Array([1, 2, 3]));
  assert.equal((await blob.stat('live/a.txt')).size, 5);

  const scratch = storage.scratchStorageForRef(ref);
  const scratchKey = await scratch.create('temporary', 'result', '.txt');
  assert.equal(await scratch.read(scratchKey), 'temporary');
  await scratch.config.set('retention.maxAgeMs', 5000);
  assert.equal(await scratch.config.get('retention.maxAgeMs'), 5000);

  const archive = storage.archiveFactoryForRef(ref);
  await archive.stream('events').append({ type: 'created' });
  await archive.blob('snapshots').write('one.json', '{}');
  assert.deepEqual(await archive.listStreams(), ['events']);
  assert.deepEqual(await archive.listBlobs(), ['snapshots']);

  const provider = storage.storageProviderForRef(ref);
  await provider.kv.write('provider', true);
  assert.equal(await provider.kv.read('provider'), true);
});

test('journal appends duplicate payloads and uses exact exclusive cursors', async (t) => {
  const { storage, ref } = await fixture(t);
  const journal = storage.journalStorageForRef(ref);
  const first = await journal.append({ eventId: 'same' });
  const second = await journal.append({ eventId: 'same' });
  const third = await journal.append({ eventId: 'other' });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await journal.readAfter(first.id), { entries: [second, third], newCursor: third.id });
  assert.deepEqual(await journal.readAfter(third.id), { entries: [], newCursor: third.id });
  assert.deepEqual((await journal.readAfter('unknown')).entries, [first, second, third]);
});

test('queue supports dedup, staging, leasing, retry, expiry, ack, and dead letters', async (t) => {
  const { storage, ref } = await fixture(t);
  const queue = storage.queueStorageForRef(ref, 'effects');
  const queued = await queue.enqueueIfAbsent({ task: 'one' }, 'task-one');
  assert.equal(await queue.enqueueIfAbsent({ task: 'duplicate' }, 'task-one'), null);
  const staged = await queue.stage({ task: 'later' }, { dedupKey: 'later' });
  assert.deepEqual(await queue.peekStaged(), [staged]);
  assert.equal(await queue.commitStaged(staged.id), true);

  const [leased] = await queue.lease({ max: 1, visibilityMs: 1 });
  assert.equal(leased.id, queued.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const [retried] = await queue.lease({ max: 1 });
  assert.equal(retried.id, queued.id);
  assert.equal(retried.attempt, 2);
  assert.equal(await queue.ack(retried.id, 'wrong'), false);
  assert.equal(await queue.nack(retried.id, retried.leaseToken, { dead: true, reason: 'failed' }), true);
  assert.equal((await queue.peekDeadLetter())[0].reason, 'failed');
  assert.ok(await queue.enqueueIfAbsent({ task: 'replacement' }, 'task-one'));
});

test('relay lock is non-blocking and holder-safe', async (t) => {
  const { rootDir } = await fixture(t);
  const first = createFsAtomicRelayLock(path.join(rootDir, 'relay.lock'));
  const second = createFsAtomicRelayLock(path.join(rootDir, 'relay.lock'));
  const release = await first.tryAcquire();
  assert.ok(release);
  assert.equal(await second.tryAcquire(), null);
  await release();
  const nextRelease = await second.tryAcquire();
  assert.ok(nextRelease);
  await release();
  assert.equal(await first.tryAcquire(), null);
  await nextRelease();
});