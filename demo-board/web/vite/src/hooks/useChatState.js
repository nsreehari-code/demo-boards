import { useCallback, useMemo } from 'react';
import { dispatchAction, subscribeCardChats, unsubscribeCardChats, uploadFileForChat } from '../lib/client.js';
import { useCardState } from './useCardState.js';

export function useChatState(boardId, cardId) {
  const card = useCardState(boardId, cardId);

  if (!card || !cardId) return null;

  const chatState = card.chatState ?? null;
  const boardSseClientId = card.boardSseClientId ?? null;
  const filesUploaded = card.filesUploaded ?? [];

  const sendChat = useCallback(
    (text, payload = {}) => dispatchAction(boardId, cardId, 'chat-send', { text, ...payload }),
    [boardId, cardId],
  );

  const uploadChatFile = useCallback(
    (file) => uploadFileForChat(boardId, cardId, file),
    [boardId, cardId],
  );

  const subscribeChat = useCallback(() => {
    if (!boardSseClientId) return Promise.resolve(null);
    return subscribeCardChats(boardId, cardId, boardSseClientId);
  }, [boardId, cardId, boardSseClientId]);

  const unsubscribeChat = useCallback(() => {
    if (!boardSseClientId) return Promise.resolve(null);
    return unsubscribeCardChats(boardId, cardId, boardSseClientId);
  }, [boardId, cardId, boardSseClientId]);

  const chatActions = useMemo(() => ({
    sendChat,
    uploadFileForChat: uploadChatFile,
    subscribeChat,
    unsubscribeChat,
  }), [sendChat, uploadChatFile, subscribeChat, unsubscribeChat]);

  return {
    ...(chatState ?? {}),
    boardSseClientId,
    chatActions,
    filesUploaded,
  };
}
