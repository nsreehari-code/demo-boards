import { createFsPathBoardLayoutsStore } from './fs-path-store.js';
import { createFirestoreBoardLayoutsStore } from './firestore-store.js';

export function createBoardLayoutsStore({ registry, adapterServices }) {
  const ref = registry?.boardsLayoutRef;
  switch (ref?.kind) {
    case 'fs-path':
      return createFsPathBoardLayoutsStore({ registry });
    case 'firestore':
      return createFirestoreBoardLayoutsStore({ registry, adapterServices });
    default:
      throw new Error(`Unsupported boards-layout kind '${ref?.kind ?? ''}'`);
  }
}