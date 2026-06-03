import fs from 'node:fs';
import {
  createBoardLiveCardsNonCorePublic,
  createFsBoardNonCorePlatformAdapter,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

function makeHostedTaskExecutorRef(boardId) {
  return {
    meta: 'task-executor',
    howToRun: 'queue-storage',
    whatToRun: serializeRef({ kind: 'queue-storage', value: `board:${boardId}:board-worker` }),
    extra: { boardId },
  };
}

function makeLocalTaskExecutorRef(scriptPath, extra) {
  if (!scriptPath) return undefined;
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: scriptPath }),
    ...(extra !== undefined ? { extra } : {}),
  };
}

function isHostedTaskExecutorRef(ref) {
  return ref?.howToRun === 'queue-storage'
    || ref?.howToRun === 'in-process-loop'
    || ref?.howToRun === 'http:post'
    || ref?.howToRun === 'http:get';
}

function ensureFsPathDir(ref) {
  if (!ref) return;
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (parsed?.kind === 'fs-path' && typeof parsed.value === 'string' && parsed.value.trim()) {
    fs.mkdirSync(parsed.value, { recursive: true });
  }
}

function ensureBoardDirs(refs) {
  ensureFsPathDir(refs.baseRef);
  ensureFsPathDir(refs.cardStoreRef);
  ensureFsPathDir(refs.outputsStoreRef);
  ensureFsPathDir(refs.scratchStoreRef);
  ensureFsPathDir(refs.archiveStoreRef);
  ensureFsPathDir(refs.chatStoreRef);
  ensureFsPathDir(refs.artifactsStoreRef);
}

export function buildBoardBundle(boardId, boardConfig, _localFsServices = {}, runtimeHooks = {}, options = {}) {
  const refs = boardConfig?.refs;
  if (!refs?.baseRef || refs.baseRef.kind !== 'fs-path' || !refs.baseRef.value) {
    throw new Error(`localfs board ${boardId} requires refs.baseRef as an fs-path object`);
  }

  ensureBoardDirs(refs);

  const adapterOpts = {
    suppressSpawn: true,
    onWarn: (message) => console.warn(`[localfs-adapter] ${message}`),
    ...(options.callbackTransport ? { callbackTransport: options.callbackTransport } : {}),
  };
  const boardAdapter = createFsBoardPlatformAdapter(refs.baseRef, adapterOpts);
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(refs.baseRef, adapterOpts);

  const requestProcessAccumulated = typeof runtimeHooks.requestProcessAccumulated === 'function'
    ? runtimeHooks.requestProcessAccumulated
    : () => {};
  boardAdapter.requestProcessAccumulated = requestProcessAccumulated;
  nonCoreAdapter.requestProcessAccumulated = requestProcessAccumulated;

  const taskExecutorModulePath = typeof boardConfig?.taskExecutorModule === 'string' && boardConfig.taskExecutorModule.trim()
    && typeof options.resolveConfigRelativePath === 'function'
    ? options.resolveConfigRelativePath(options.configDir, boardConfig.taskExecutorModule)
    : '';
  const localSyncTaskExecutorRef = makeLocalTaskExecutorRef(taskExecutorModulePath, { boardId });
  if (localSyncTaskExecutorRef) {
    const invokeExecutor = nonCoreAdapter.invokeExecutor.bind(nonCoreAdapter);
    nonCoreAdapter.invokeExecutor = (ref, subcommand, execOpts) => {
      const resolvedRef = isHostedTaskExecutorRef(ref) ? localSyncTaskExecutorRef : ref;
      return invokeExecutor(resolvedRef, subcommand, execOpts);
    };
  }

  const nonCore = createBoardLiveCardsNonCorePublic(refs.baseRef, nonCoreAdapter);

  return {
    refs,
    boardAdapter,
    nonCore,
    boardContextConfig: {
      label: boardConfig.label || boardId,
      boardAdapter,
      nonCore,
      taskExecutorRef: makeHostedTaskExecutorRef(boardId),
      ...refs,
    },
  };
}