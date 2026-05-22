#!/usr/bin/env node

import {
  appendAssistantReply,
  appendSystemMessage,
  configureWorkspaceCliScripts,
  readJsonStdin,
  requireRequiredStrings,
  resolveCopilotWorkspaceDir,
} from './shared.js';

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
  aiWorkspaceRoot = '',
  cardStoreRef = '',
  chatStoreRef = '',
  cardId = '',
  userText = '',
} = extra;

requireRequiredStrings({
  aiWorkspaceRoot,
  cardStoreRef,
  chatStoreRef,
  cardId,
  userText,
}, 'probe');

try {
  const workingDir = resolveCopilotWorkspaceDir(aiWorkspaceRoot, cardStoreRef, cardId, 'probe');
  configureWorkspaceCliScripts(workingDir, 'probe');
  appendSystemMessage(chatStoreRef, cardId, 'in-progress');
  const replyText = `Echo: ${normalizeProbeMessageText(userText)}`;
  // User-visible probe text must be written through chat store only.
  appendAssistantReply(chatStoreRef, cardId, replyText);
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}