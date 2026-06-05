import { createFsPathBoardsStore } from './fs-path-store.js';
import { createFirestoreBoardsStore } from './firestore-store.js';

export function createBoardsIndexStore({ ref, adapterServices }) {
  switch (ref.kind) {
    case 'fs-path':
      return createFsPathBoardsStore({ ref });
    case 'firestore':
      return createFirestoreBoardsStore({ ref, adapterServices });
    default:
      throw new Error(`Unsupported boards-index kind '${ref.kind}'`);
  }
}
