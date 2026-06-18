import { createFsPathBoardLayoutsStore } from './fs-path-store.js';

export function createBoardLayoutsStore({ registry }) {
  const ref = registry?.boardsLayoutRef;
  switch (ref?.kind) {
    case 'fs-path':
      return createFsPathBoardLayoutsStore({ registry });
    default:
      throw new Error(`Unsupported boards-layout kind '${ref?.kind ?? ''}'`);
  }
}