import { createFsPathBoardsStore } from './fs-path-store.js';

export function createBoardsIndexStore({ registry }) {
  const ref = registry?.boardsIndexRef;
  switch (ref.kind) {
    case 'fs-path':
      return createFsPathBoardsStore({ registry });
    default:
      throw new Error(`Unsupported boards-index kind '${ref.kind}'`);
  }
}
