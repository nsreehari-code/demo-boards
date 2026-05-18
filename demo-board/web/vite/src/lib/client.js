/**
 * boardApi.js — thin fetch wrappers for the board-server HTTP API.
 * The server has Access-Control-Allow-Origin: * so direct connections work.
 */
export const SERVER = 'http://127.0.0.1:7799';
const base = (boardId) => `${SERVER}/api/boards/${boardId}`;

export const initBoard = (boardId) =>
  fetch(`${base(boardId)}/init-board`);

export const refreshCard = (boardId, cardId) =>
  fetch(`${base(boardId)}/cards/${cardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
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
    body: JSON.stringify({ type, ...payload }),
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

export const subscribeCardChats = (boardId, cardId) =>
  fetch(`${base(boardId)}/cards/${cardId}/chats/subscribe-sse`, { method: 'POST' });

export const unsubscribeCardChats = (boardId, cardId) =>
  fetch(`${base(boardId)}/cards/${cardId}/chats/unsubscribe-sse`, { method: 'POST' });
