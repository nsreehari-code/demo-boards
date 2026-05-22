/**
 * boardApi.js — thin fetch wrappers for the board-server HTTP API.
 * The server has Access-Control-Allow-Origin: * so direct connections work.
 */
export { SERVER } from './appConfig.js';
import { SERVER } from './appConfig.js';
const base = (boardId) => `${SERVER}/api/boards/${boardId}`;

export const healthz = () =>
  fetch(`${SERVER}/healthz`);

export const initBoard = (boardId) =>
  fetch(`${base(boardId)}/init-board`);

export const refreshCard = (boardId, cardId) =>
  fetch(`${base(boardId)}/cards/${cardId}/retrigger`, {
    method: 'POST',
  });

export const resyncSeedCards = (boardId) =>
  fetch(`${base(boardId)}/resync-seedcards`, {
    method: 'POST',
  });

export const patchCard = (boardId, cardId, patch) =>
  fetch(`${base(boardId)}/cards/${cardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const dispatchAction = (boardId, cardId, type, payload = {}) =>
  fetch(`${base(boardId)}/cards/${cardId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionType: type, payload }),
  });

export const uploadFile = (boardId, cardId, file) =>
  fetch(`${base(boardId)}/cards/${cardId}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });

export const uploadFileForChat = (boardId, cardId, file) =>
  fetch(`${base(boardId)}/cards/${cardId}/files?inChat=true`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });

export const subscribeCardChats = (boardId, cardId, clientId) =>
  fetch(`${base(boardId)}/cards/${cardId}/chats/subscribe-sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });

export const unsubscribeCardChats = (boardId, cardId, clientId) =>
  fetch(`${base(boardId)}/cards/${cardId}/chats/unsubscribe-sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
