import { buildBoardConfig } from '../firebase-adapter/load-config.js';
import { createBoardsIndexStore } from './boards-index-store.js';

export function createDynamicBoards({ hostConfig, adapterServices }) {
  const store = createBoardsIndexStore({ ref: hostConfig.boardsIndexRef, adapterServices });
  const ctx = {
    configDir: hostConfig.configDir,
    refsTemplates: hostConfig.refsTemplates,
    aiWorkspaceTemplates: hostConfig.aiWorkspaceTemplates,
  };

  function hydrate(id, record) {
    return buildBoardConfig(id, record, ctx);
  }

  async function ensureSeeded() {
    const existing = await store.list();
    if (existing.length > 0) return { seeded: 0, total: existing.length };
    let seeded = 0;
    for (const [id, record] of Object.entries(hostConfig.sampleBoards || {})) {
      await store.put(id, record);
      seeded += 1;
    }
    return { seeded, total: seeded };
  }

  async function list() {
    const entries = await store.list();
    return entries.map(({ id, record }) => hydrate(id, record));
  }

  async function get(boardId) {
    const record = await store.get(boardId);
    return record ? hydrate(boardId, record) : null;
  }

  async function add(boardId, record) {
    if (await store.has(boardId)) {
      const err = new Error(`board '${boardId}' already exists`);
      err.code = 'EEXIST';
      throw err;
    }
    await store.put(boardId, record);
    return hydrate(boardId, record);
  }

  async function saveMeta(boardId, metadata) {
    const record = await store.get(boardId);
    if (!record) return null;
    const currentMetadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {};
    const incomingMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : {};
    const nextRecord = { ...record, metadata: { ...currentMetadata, ...incomingMetadata } };
    await store.set(boardId, nextRecord);
    return hydrate(boardId, nextRecord);
  }

  return { ensureSeeded, list, get, add, saveMeta, store };
}
