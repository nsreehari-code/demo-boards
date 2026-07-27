import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFilesystemDurableStorage } from '@gik/durable-runtime/storage/filesystem';
import { createFilesystemStorageDispatcher } from '../filesystem/protocol.js';
import { createFilesystemStorageLibrary } from '../filesystem/storage.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function createFilesystemToolHandler(options = {}) {
  const rootDir = path.resolve(options.rootDir
    ?? process.env.DEMO_BOARDS_FILESYSTEM_STORAGE_ROOT
    ?? path.join(serverRoot, '.data', 'filesystem-storage'));
  const storage = createFilesystemStorageLibrary({ rootDir });
  const dispatcher = createFilesystemStorageDispatcher(storage);
  const durableStorage = createFilesystemDurableStorage(storage);

  return async function handleFilesystemTool(args, tool) {
    switch (tool.name) {
      case 'filesystem.create_ref':
        return result({ ref: storage.createRef(args.namespace), kind: 'fs-path' });
      case 'filesystem.storage_batch':
        return result({ results: await dispatcher.dispatchBatch(args.operations) });
      case 'filesystem.runtime_initialize':
        return result({ initialization: await durableStorage.initializeRuntime(args) });
      case 'filesystem.journal_append_and_wake':
        return result({ entry: await durableStorage.appendJournalAndWake(args) });
      case 'filesystem.engine_wake_read':
        return result({ wake: await durableStorage.readEngineWake(args) });
      case 'filesystem.engine_wake_processed':
        await durableStorage.markEngineWakeProcessed(args);
        return result({ processed: true });
      case 'filesystem.transition_acquire':
        return result({ transition: await durableStorage.acquireTransition(args) });
      case 'filesystem.transition_commit':
        return result(await durableStorage.commitTransition(args));
      case 'filesystem.transition_abort':
        return result({ aborted: await durableStorage.abortTransition(args) });
      case 'filesystem.effect_lease': {
        const messages = await durableStorage.effectsQueueStorage(args.effectsQueueRef, args.effectsLane)
          .lease({ max: 1, visibilityMs: args.visibilityMs });
        return result({ message: messages[0] ?? null });
      }
      case 'filesystem.effect_ack':
        return result({
          acknowledged: await durableStorage.effectsQueueStorage(args.effectsQueueRef, args.effectsLane)
            .ack(args.messageId, args.leaseToken),
        });
      case 'filesystem.effect_nack':
        return result({
          released: await durableStorage.effectsQueueStorage(args.effectsQueueRef, args.effectsLane)
            .nack(args.messageId, args.leaseToken, { dead: args.dead, reason: args.reason }),
        });
      default:
        throw new Error(`Unsupported filesystem tool: ${tool.name}`);
    }
  };
}

export const handleFilesystemTool = createFilesystemToolHandler();