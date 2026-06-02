import { createFirestoreBoardRuntimeBundle } from '../../../yaml-flow/lib/firestore-storage/index.js';
import { wrapWithFirebaseStorageBlobs } from '../../../yaml-flow/lib/firebase-storage/index.js';

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
    boardContextConfig: {
      label: boardConfig.label || boardId,
      boardAdapter: composedBoardAdapter,
      ...refs,
    },
  };
}
