import { createFirestoreBoardRuntimeBundle } from 'yaml-flow/firestore-storage';
import {
  createHostedAsyncBoardNonCorePublic,
  createNonCoreExecutorDispatcher,
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

export function buildBoardBundle(boardId, boardConfig, firebaseServices, runtimeHooks = {}, options = {}) {
  const { refs, boardAdapter } = createFirestoreBoardRuntimeBundle(
    firebaseServices.firestore,
    boardId,
    {
      refs: boardConfig.refs,
      requestProcessAccumulated: runtimeHooks.requestProcessAccumulated,
      publishBoardChangeNotifications: runtimeHooks.publishBoardChangeNotifications,
    },
  );
  const dispatcher = createNonCoreExecutorDispatcher({ resolveCliDir: () => process.cwd() });
  const nonCore = createHostedAsyncBoardNonCorePublic(boardAdapter, {
    invokeExecutor: dispatcher.invokeExecutor,
    ...(options.taskExecutorRef ? { taskExecutorRef: options.taskExecutorRef } : {}),
  });

  if (options.callbackTransport) {
    boardAdapter.callbackTransport = options.callbackTransport;
  }

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
