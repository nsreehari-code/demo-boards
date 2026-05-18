import { dispatchAction, subscribeCardChats, unsubscribeCardChats, uploadFileForChat } from '../lib/client.js';
import { useCardState } from './useCardState.js';

export function useChatState(boardId, cardId) {
  const card = useCardState(boardId, cardId);

  if (!card || !cardId) return null;

  const chatState = card.chatState ?? null;

  const chatActions = {
    sendChat: (text, payload = {}) => dispatchAction(boardId, cardId, 'chat-send', { text, ...payload }),
    uploadFileForChat: (file) => uploadFileForChat(boardId, cardId, file),
    subscribeChat: () => subscribeCardChats(boardId, cardId),
    unsubscribeChat: () => unsubscribeCardChats(boardId, cardId),
  };

  return {
    ...(chatState ?? {}),
    chatActions,
  };
}
