#!/usr/bin/env node

import { readJsonStdin, requireRequiredStrings } from './copilot-chat/shared.js';

const input = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  serverUrl = '',
  state = '',
} = input;

requireRequiredStrings({ boardId, cardId, serverUrl, state }, 'chat processing controlplane');

if (state !== 'started' && state !== 'done') {
  throw new Error(`Unsupported chat processing state: ${state}`);
}

const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/boards/${encodeURIComponent(boardId)}/mcp-controlplane`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tool: state === 'started' ? 'setstate.chat-processing-started' : 'setstate.chat-processing-done',
    args: {
      board_id: boardId,
      card_id: cardId,
    },
  }),
});

const payload = await response.json().catch(() => ({}));
if (!response.ok || payload?.status === 'fail' || payload?.status === 'error') {
  const errorMessage = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : `Failed to set chat processing state to ${state}`;
  throw new Error(errorMessage);
}

process.stdout.write(JSON.stringify({ ok: true, state }));