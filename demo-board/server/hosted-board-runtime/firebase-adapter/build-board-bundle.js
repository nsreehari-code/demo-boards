import { createFirestoreBoardRuntimeBundle } from 'yaml-flow/firestore-storage';
import { wrapWithFirebaseStorageBlobs } from 'yaml-flow/firebase-storage';
import { serializeRef } from 'yaml-flow/board-live-cards-node';

function makeHostedTaskExecutorRef(boardId) {
  return {
    meta: 'task-executor',
    howToRun: 'queue-storage',
    whatToRun: serializeRef({ kind: 'queue-storage', value: `board:${boardId}:board-worker` }),
    extra: { boardId },
  };
}

export function buildBoardBundle(boardId, boardConfig, firebaseServices, runtimeHooks = {}, options = {}) {
  const { refs, boardAdapter, nonCore } = createFirestoreBoardRuntimeBundle(
    firebaseServices.firestore,
    boardId,
    {
      refs: boardConfig.refs,
      requestProcessAccumulated: runtimeHooks.requestProcessAccumulated,
      publishBoardChangeNotifications: runtimeHooks.publishBoardChangeNotifications,
      nonCoreTaskExecutor: options.nonCoreTaskExecutor,
      nonCoreTaskExecutorRef: options.nonCoreTaskExecutorRef,
    },
  );

  const composedBoardAdapter = wrapWithFirebaseStorageBlobs(
    boardAdapter,
    firebaseServices.storage,
    boardId,
  );

  if (options.callbackTransport) {
    composedBoardAdapter.callbackTransport = options.callbackTransport;
  }

  return {
    refs,
    boardAdapter: composedBoardAdapter,
    nonCore,
    boardContextConfig: {
      label: boardConfig.label || boardId,
      boardAdapter: composedBoardAdapter,
      nonCore,
      taskExecutorRef: makeHostedTaskExecutorRef(boardId),
      ...refs,
    },
  };
}
