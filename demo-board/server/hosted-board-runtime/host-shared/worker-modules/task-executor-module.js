import { pathToFileURL } from 'node:url';

import { serializeRef } from 'yaml-flow/board-live-cards-node';

export async function loadTaskExecutorModule(boardId, boardConfig, resolveConfigRelativePath, configDir) {
  if (!boardConfig.taskExecutorModule) return undefined;
  const absolutePath = resolveConfigRelativePath(configDir, boardConfig.taskExecutorModule);
  const mod = await import(pathToFileURL(absolutePath).href);
  if (typeof mod.executeTaskExecutorRequest !== 'function') {
    throw new Error(`Task executor module for ${boardId} must export executeTaskExecutorRequest(request)`);
  }
  return mod.executeTaskExecutorRequest;
}

export function createHostedImmediateTaskExecutorRef(boardId, boardConfig, resolveConfigRelativePath, configDir, extra = undefined) {
  if (!boardConfig.taskExecutorModule) return undefined;
  const absolutePath = resolveConfigRelativePath(configDir, boardConfig.taskExecutorModule);
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: absolutePath }),
    extra: {
      boardId,
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
    },
  };
}
