import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { watch } from 'chokidar';
import { createFilesystemStorageLibrary } from '@gik/durable-runtime/storage/filesystem/library';

export const FILESYSTEM_SNAPSHOT_INVALIDATION_NOTIFICATION =
  'notifications/gik/runtime_snapshot_invalidated';

const RUNTIME_STATE_SUFFIX = path.join('kv', '__gik_runtime_state__.json');

export function createFilesystemSnapshotInvalidationWatcher(options) {
  const rootDir = path.resolve(options.rootDir);
  const storage = createFilesystemStorageLibrary({ rootDir });
  const pending = new Map();
  const debounceMs = Math.max(1, options.debounceMs ?? 25);
  const watcher = watch(rootDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 10 },
  });
  const ready = new Promise((resolve) => watcher.once('ready', resolve));

  async function publish(filePath) {
    pending.delete(filePath);
    try {
      const checkpoint = JSON.parse(await readFile(filePath, 'utf8'));
      if (typeof checkpoint?.runtimeId !== 'string' || typeof checkpoint?.revision !== 'string') return;
      const namespacePath = path.dirname(path.dirname(filePath));
      const namespace = path.relative(rootDir, namespacePath);
      if (!namespace || namespace.startsWith('..') || path.isAbsolute(namespace)) return;
      await options.publish({
        runtimeId: checkpoint.runtimeId,
        stateRef: storage.createRef(namespace),
        observedRevision: checkpoint.revision,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      options.onError?.(error);
    }
  }

  function schedule(filePath) {
    const absolutePath = path.resolve(filePath);
    if (!absolutePath.endsWith(RUNTIME_STATE_SUFFIX)) return;
    const existing = pending.get(absolutePath);
    if (existing) clearTimeout(existing);
    pending.set(absolutePath, setTimeout(() => void publish(absolutePath), debounceMs));
  }

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('error', (error) => options.onError?.(error));

  return {
    ready,
    async close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await watcher.close();
    },
  };
}
