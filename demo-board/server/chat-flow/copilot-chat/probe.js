#!/usr/bin/env node

import { appendAssistantReply, appendSystemMessage, readJsonStdin, readLastChatMessage, requireRequiredStrings } from './shared.js';

const PROBE_MARKER = '__probe__echo__probe__';

function normalizeProbeMessageText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const markerLength = PROBE_MARKER.length;
  if (
    trimmed.length >= (markerLength * 2)
    && trimmed.startsWith(PROBE_MARKER)
    && trimmed.endsWith(PROBE_MARKER)
  ) {
    return trimmed.slice(markerLength, trimmed.length - markerLength).trim();
  }
  return trimmed;
}

const extra = readJsonStdin();
const {
  chatStoreRef = '',
  cardId = '',
} = extra;

requireRequiredStrings({
  chatStoreRef,
  cardId,
}, 'probe');

try {
  const lastMessage = readLastChatMessage(chatStoreRef, cardId);
  if (!lastMessage || typeof lastMessage.text !== 'string' || lastMessage.text.trim().length === 0) {
    throw new Error('Probe handler did not find a chat message to echo');
  }
  appendSystemMessage(chatStoreRef, cardId, 'in-progress');
  const replyText = `Echo: ${normalizeProbeMessageText(lastMessage.text)}`;
  // User-visible probe text must be written through chat store only.
  appendAssistantReply(chatStoreRef, cardId, replyText);
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}