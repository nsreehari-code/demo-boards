import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  return async function handleFilesystemTool(args, tool) {
    switch (tool.name) {
      case 'filesystem.create_ref':
        return result({ ref: storage.createRef(args.namespace), kind: 'fs-path' });
      case 'filesystem.storage_batch':
        return result({ results: await dispatcher.dispatchBatch(args.operations) });
      default:
        throw new Error(`Unsupported filesystem tool: ${tool.name}`);
    }
  };
}

export const handleFilesystemTool = createFilesystemToolHandler();