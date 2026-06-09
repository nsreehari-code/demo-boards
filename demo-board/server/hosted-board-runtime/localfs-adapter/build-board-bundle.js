import fs from 'node:fs';
import {
  createBoardLiveCardsNonCorePublic,
  createFsBoardNonCorePlatformAdapter,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

function getNamedPipePath(pipeName) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
  return `/tmp/${pipeName}.sock`;
}

function makeNotifyChannel(boardId) {
  return `hosted-board-runtime-${boardId}`;
}

function makeHostedTaskExecutorRef(boardId) {
  return {
    meta: 'task-executor',
    howToRun: 'queue-storage',
    whatToRun: serializeRef({ kind: 'queue-storage', value: `board:${boardId}:board-worker` }),
    extra: { boardId },
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

function buildHostedChatHandlerFlow(boardConfig) {
  const chat = boardConfig?.chat;
  const ai = typeof boardConfig?.ai === 'string' ? boardConfig.ai.trim() : '';
  if ((!chat || typeof chat !== 'object' || Array.isArray(chat)) && !ai) {
    return undefined;
  }
  return { kind: 'hosted-chat-agent' };
}

export function buildBoardBundle(boardId, boardConfig, _localFsServices = {}, runtimeHooks = {}, options = {}) {
  const refs = boardConfig?.refs;
  const baseRef = normalizeKindValueRef(refs?.baseRef);
  if (!baseRef || baseRef.kind !== 'fs-path' || !baseRef.value) {
    throw new Error(`localfs board ${boardId} requires refs.baseRef as an fs-path ref`);
  }
  if (!options.taskExecutorRef) {
    throw new Error(`localfs board ${boardId} requires options.taskExecutorRef`);
  }

  const serializedRefs = {
    baseRef,
    boardRuntimeStoreRef: normalizeSerializedRef(refs.boardRuntimeStoreRef),
    cardStoreRef: normalizeSerializedRef(refs.cardStoreRef),
    outputsStoreRef: normalizeSerializedRef(refs.outputsStoreRef),
    queueStoreRef: normalizeSerializedRef(refs.queueStoreRef),
    chatStoreRef: normalizeSerializedRef(refs.chatStoreRef),
    artifactsStoreRef: normalizeSerializedRef(refs.artifactsStoreRef),
    fetchedSourcesStoreRef: normalizeSerializedRef(refs.fetchedSourcesStoreRef),
  };

  ensureBoardDirs(refs);
  const immediateTaskExecutorRef = options.taskExecutorRef;
  const notifyChannel = makeNotifyChannel(boardId);
  const notifyRef = { kind: 'named-pipe', value: getNamedPipePath(notifyChannel) };

  const adapterOpts = {
    suppressSpawn: true,
    onWarn: (message) => console.warn(`[localfs-adapter] ${message}`),
    boardRuntimeStoreRef: serializedRefs.boardRuntimeStoreRef,
    queueStoreRef: serializedRefs.queueStoreRef,
    notifyChannel,
    ...(options.callbackTransport ? { callbackTransport: options.callbackTransport } : {}),
  };
  const nonCoreAdapterOpts = {
    ...adapterOpts,
    resolveRef: (ref) => (isHostedTaskExecutorRef(ref) ? immediateTaskExecutorRef : ref),
  };
  const cliDir = process.cwd();
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, cliDir, adapterOpts);
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(baseRef, cliDir, nonCoreAdapterOpts);

  const requestProcessAccumulated = typeof runtimeHooks.requestProcessAccumulated === 'function'
    ? runtimeHooks.requestProcessAccumulated
    : () => {};
  boardAdapter.requestProcessAccumulated = requestProcessAccumulated;
  nonCoreAdapter.requestProcessAccumulated = requestProcessAccumulated;

  const hostedTaskExecutorRef = makeHostedTaskExecutorRef(boardId);
  const chatHandlerFlow = buildHostedChatHandlerFlow(boardConfig);
  const nonCore = createBoardLiveCardsNonCorePublic(baseRef, nonCoreAdapter, {
    boardRuntimeStoreRef: serializedRefs.boardRuntimeStoreRef,
    taskExecutorRef: hostedTaskExecutorRef,
    ...(chatHandlerFlow ? { chatHandlerFlow } : {}),
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
      notifyRef,
      ...(chatHandlerFlow ? { chatHandlerFlow } : {}),
      ...serializedRefs,
    },
  };
}