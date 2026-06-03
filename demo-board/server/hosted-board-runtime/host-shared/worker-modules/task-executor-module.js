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

export function createHostedImmediateTaskExecutorRef(boardId, boardConfig, resolveConfigRelativePath, configDir) {
  if (!boardConfig.taskExecutorModule) return undefined;
  const absolutePath = resolveConfigRelativePath(configDir, boardConfig.taskExecutorModule);
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: absolutePath }),
    extra: { boardId },
  };
}

export function createHostedImmediateTaskExecutorHook(executeTaskExecutorRequest, defaultExtra = {}) {
  if (typeof executeTaskExecutorRequest !== 'function') return undefined;
  return async ({ subcommand, input, timeoutMs }) => {
    return await executeTaskExecutorRequest({
      subcommand,
      ...(input !== undefined ? { input } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(defaultExtra && Object.keys(defaultExtra).length > 0 ? { extra: defaultExtra } : {}),
    });
  };
}
