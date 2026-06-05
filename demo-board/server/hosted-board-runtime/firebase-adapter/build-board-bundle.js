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

function buildHostedChatHandlerFlow(boardConfig) {
  const chat = boardConfig?.chat;
  const ai = typeof boardConfig?.ai === 'string' ? boardConfig.ai.trim() : '';
  if ((!chat || typeof chat !== 'object' || Array.isArray(chat)) && !ai) {
    return undefined;
  }
  return { kind: 'hosted-chat-agent' };
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
  const chatHandlerFlow = buildHostedChatHandlerFlow(boardConfig);
  const nonCore = createHostedAsyncBoardNonCorePublic(boardAdapter, {
    invokeExecutor: dispatcher.invokeExecutor,
    ...(options.taskExecutorRef ? { taskExecutorRef: options.taskExecutorRef } : {}),
    ...(chatHandlerFlow ? { chatHandlerFlow } : {}),
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
      ...(chatHandlerFlow ? { chatHandlerFlow } : {}),
      ...refs,
    },
  };
}
