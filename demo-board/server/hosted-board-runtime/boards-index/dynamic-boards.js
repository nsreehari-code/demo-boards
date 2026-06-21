import { createBoardContainerLifecycle, createFsBoardContainerStorage } from 'yaml-flow/board-live-cards-node';
import { buildBoardConfig } from '../localfs-adapter/load-config.js';

export function createDynamicBoards({ hostConfig, adapterServices }) {
  void adapterServices;
  const storage = createFsBoardContainerStorage({ registry: hostConfig.runtimeBoardsRegistry });
  const ctx = {
    configDir: hostConfig.configDir,
    refsTemplates: hostConfig.refsTemplates,
    aiWorkspaceTemplates: hostConfig.aiWorkspaceTemplates,
    uiTemplates: hostConfig.uiTemplates,
  };

  function hydrate(id, record) {
    return buildBoardConfig(id, record, ctx);
  }

  return createBoardContainerLifecycle({
    storage,
    hydrate,
    resolveWorkspaceDir(board) {
      return board?.refs?.baseRef?.kind === 'fs-path' && typeof board.refs.baseRef.value === 'string'
        ? board.refs.baseRef.value
        : '';
    },
  });
}
