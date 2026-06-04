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

function normalizeKindValueRef(ref) {
  if (!ref) return undefined;
  return typeof ref === 'string' ? parseRef(ref) : ref;
}

function normalizeSerializedRef(ref) {
  return typeof ref === 'string' ? ref : serializeRef(ref);
}

export function buildBoardBundle(boardId, boardConfig, _localFsServices = {}, runtimeHooks = {}, options = {}) {
  const refs = boardConfig?.refs;
  const baseRef = normalizeKindValueRef(refs?.baseRef);
  if (!baseRef || baseRef.kind !== 'fs-path' || !baseRef.value) {
    throw new Error(`localfs board ${boardId} requires refs.baseRef as an fs-path ref`);
  }

  const serializedRefs = {
    baseRef,
    boardRuntimeStoreRef: normalizeSerializedRef(refs.boardRuntimeStoreRef),
    cardStoreRef: normalizeSerializedRef(refs.cardStoreRef),
    outputsStoreRef: normalizeSerializedRef(refs.outputsStoreRef),
    queueStoreRef: normalizeSerializedRef(refs.queueStoreRef),
    scratchStoreRef: normalizeSerializedRef(refs.scratchStoreRef),
    archiveStoreRef: normalizeSerializedRef(refs.archiveStoreRef),
    chatStoreRef: normalizeSerializedRef(refs.chatStoreRef),
    artifactsStoreRef: normalizeSerializedRef(refs.artifactsStoreRef),
    fetchedSourcesStoreRef: normalizeSerializedRef(refs.fetchedSourcesStoreRef),
  };

  ensureBoardDirs(refs);

  const taskExecutorModulePath = typeof boardConfig?.taskExecutorModule === 'string' && boardConfig.taskExecutorModule.trim()
    && typeof options.resolveConfigRelativePath === 'function'
    ? options.resolveConfigRelativePath(options.configDir, boardConfig.taskExecutorModule)
    : '';
  const localSyncTaskExecutorRef = makeLocalTaskExecutorRef(taskExecutorModulePath, { boardId });

  const adapterOpts = {
    suppressSpawn: true,
    onWarn: (message) => console.warn(`[localfs-adapter] ${message}`),
    ...(options.callbackTransport ? { callbackTransport: options.callbackTransport } : {}),
  };
  const nonCoreAdapterOpts = {
    ...adapterOpts,
    ...(localSyncTaskExecutorRef
      ? { resolveRef: (ref) => (isHostedTaskExecutorRef(ref) ? localSyncTaskExecutorRef : ref) }
      : {}),
  };
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, adapterOpts);
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(baseRef, nonCoreAdapterOpts);

  const requestProcessAccumulated = typeof runtimeHooks.requestProcessAccumulated === 'function'
    ? runtimeHooks.requestProcessAccumulated
    : () => {};
  boardAdapter.requestProcessAccumulated = requestProcessAccumulated;
  nonCoreAdapter.requestProcessAccumulated = requestProcessAccumulated;

  const hostedTaskExecutorRef = makeHostedTaskExecutorRef(boardId);
  const nonCore = createBoardLiveCardsNonCorePublic(baseRef, nonCoreAdapter, {
    boardRuntimeStoreRef: serializedRefs.boardRuntimeStoreRef,
    taskExecutorRef: hostedTaskExecutorRef,
  });

  return {
    refs: serializedRefs,
    boardAdapter,
    nonCore,
    boardContextConfig: {
      label: boardConfig.label || boardId,
      boardAdapter,
      nonCore,
      taskExecutorRef: hostedTaskExecutorRef,
      ...serializedRefs,
    },
  };
}