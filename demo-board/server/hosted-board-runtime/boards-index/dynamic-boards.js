import { buildBoardConfig } from '../firebase-adapter/load-config.js';
import { createBoardsIndexStore } from './boards-index-store.js';

export function createDynamicBoards({ hostConfig, adapterServices }) {
  const store = createBoardsIndexStore({ registry: hostConfig.runtimeBoardsRegistry, adapterServices });
  const ctx = {
    configDir: hostConfig.configDir,
    refsTemplates: hostConfig.refsTemplates,
    aiWorkspaceTemplates: hostConfig.aiWorkspaceTemplates,
    uiTemplates: hostConfig.uiTemplates,
  };

  function hydrate(id, record) {
    return buildBoardConfig(id, record, ctx);
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

  async function saveRecord(boardId, patch) {
    const record = await store.get(boardId);
    if (!record) return null;
    const currentMetadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {};
    const patchMetadata = patch?.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
      ? patch.metadata
      : null;
    const nextRecord = {
      ...record,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
      metadata: patchMetadata ? { ...currentMetadata, ...patchMetadata } : currentMetadata,
    };
    hydrate(boardId, nextRecord);
    await store.set(boardId, nextRecord);
    return hydrate(boardId, nextRecord);
  }

  async function deprecate(boardId) {
    const record = await store.get(boardId);
    if (!record) return null;
    if (typeof store.deprecate !== 'function') {
      throw new Error(`boards-index kind '${store.kind}' does not support deprecate`);
    }
    const board = hydrate(boardId, record);
    const workspaceDir = board?.refs?.baseRef?.kind === 'fs-path' && typeof board.refs.baseRef.value === 'string'
      ? board.refs.baseRef.value
      : '';
    const archived = await store.deprecate(boardId, { workspaceDir });
    return archived ? { board, ...archived } : null;
  }

  return { list, get, add, saveMeta, saveRecord, deprecate, store };
}
