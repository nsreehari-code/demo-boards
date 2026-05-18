import { dispatchAction, refreshCard, patchCard, uploadFileForChat } from '../lib/client.js';
import { useBoardState } from './useBoardState.js';

export function useCardState(boardId, cardId) {
  const board = useBoardState(boardId);

  if (!board || !cardId) return null;

  const cardContent = board.cardContents[cardId] ?? null;

  const requiresDataObjects = {};
  for (const token of (cardContent?.requires ?? [])) {
    if (token in board.dataObjects) {
      requiresDataObjects[token] = board.dataObjects[token];
    }
  }

  const cardActions = {
    refresh: () => refreshCard(boardId, cardId),
    patch: (patch) => patchCard(boardId, cardId, patch),
    dispatchAction: (type, payload = {}) => dispatchAction(boardId, cardId, type, payload),
    uploadFileForChat: (file) => uploadFileForChat(boardId, cardId, file),
  };

  const cardData = cardContent?.card_data ?? {};
  const chatState = board.chatStates?.[cardId] ?? null;
  const filesUploaded = cardData.files ?? [];
  const filesUploadedCount = filesUploaded.length;

  return {
    cardContent,
    cardData,
    cardRuntime: board.cardRuntimes[cardId] ?? null,
    chatState,
    requiresDataObjects,
    filesUploaded,
    filesUploadedCount,
    cardActions,
  };
}
