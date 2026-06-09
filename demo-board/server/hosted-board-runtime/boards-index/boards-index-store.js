import { createFsPathBoardsStore } from './fs-path-store.js';
import { createFirestoreBoardsStore } from './firestore-store.js';

export function createBoardsIndexStore({ registry, adapterServices }) {
  const ref = registry?.boardsIndexRef;
  switch (ref.kind) {
    case 'fs-path':
      return createFsPathBoardsStore({ registry });
    case 'firestore':
      return createFirestoreBoardsStore({ registry, adapterServices });
    default:
      throw new Error(`Unsupported boards-index kind '${ref.kind}'`);
  }
}
