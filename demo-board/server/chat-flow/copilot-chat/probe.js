#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  readEnhancedChatMessages,
  readJsonStdin,
  requireRequiredStrings,
  stageAssistantReplyViaMcp,
} from './shared.js';
import { getAgentOutputFileName } from './watchparty.js';

const PROBE_MARKER = '__probe__echo__probe__';
const PROBE_ATTACHMENT_PREFIX = '[attach]';

function normalizeProbeMessageText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const markerLength = PROBE_MARKER.length;
  let normalized = trimmed;
  if (
    trimmed.length >= (markerLength * 2)
    && trimmed.startsWith(PROBE_MARKER)
    && trimmed.endsWith(PROBE_MARKER)
  ) {
    normalized = trimmed.slice(markerLength, trimmed.length - markerLength).trim();
  }
  const stemMatch = /^([A-Za-z0-9_-]+)__(.*)$/s.exec(normalized);
  if (stemMatch) {
    return stemMatch[2].trim();
  }
  return normalized;
}

function buildProbeResponse(text) {
  const normalizedText = normalizeProbeMessageText(text);
  const wantsAttachment = normalizedText.toLowerCase().startsWith(PROBE_ATTACHMENT_PREFIX);
  const replyBody = wantsAttachment
    ? normalizedText.slice(PROBE_ATTACHMENT_PREFIX.length).trim()
    : normalizedText;
  const replyText = `Echo: ${replyBody}`;
  const files = wantsAttachment
    ? [{
      file_name: 'probe-generated-summary.txt',
      content_type: 'text/plain; charset=utf-8',
      text: [
        `Probe input: ${replyBody}`,
        `Probe reply: ${replyText}`,
      ].join('\n'),
    }]
    : [];

  return {
    replyText,
    files,
  };
}

async function resolveProbeUserText(options) {
  const inlineUserText = typeof options?.userText === 'string' ? options.userText.trim() : '';
  if (inlineUserText) {
    return inlineUserText;
  }

  const messages = await readEnhancedChatMessages(options.boardId, options.cardId, 30000, {
    turnId: options.turnId,
    logId: options.logId,
    mcpServerUrl: options.mcpServerUrl,
  });

  if (typeof options?.lastChatEntryId === 'string' && options.lastChatEntryId.trim()) {
    const exactMatch = messages.find((message) => (
      message
      && message.id === options.lastChatEntryId.trim()
      && message.role === 'user'
      && typeof message.text === 'string'
      && message.text.trim()
    ));
    if (exactMatch) {
      return exactMatch.text.trim();
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.text === 'string' && message.text.trim()) {
      return message.text.trim();
    }
  }

  throw new Error('Missing required probe input: userText');
}

const extra = readJsonStdin();
const {
  boardId = '',
  mcpServerUrl = '',
  serverUrl = '',
  aiWorkspaceRoot = '',
  cardId = '',
  logId = '',
  turnId = '',
  userText = '',
  lastChatEntryId = '',
  watchPartyFilesForChatDir = '',
} = extra;

requireRequiredStrings({
  boardId,
  cardId,
  logId,
  watchPartyFilesForChatDir,
}, 'probe');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeWatchpartyFrames(dirPath, cId, replyText) {
  const outFile = path.join(dirPath, getAgentOutputFileName(cId));
  const frames = [
    "Assistant's Output:\n",
    "Assistant's Output:\nprobe frame 1\n",
    "Assistant's Output:\nprobe frame 1\nprobe frame 2\n",
    `Assistant's Output:\nprobe frame 1\nprobe frame 2\n${replyText}\n`,
  ];

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  for (let index = 0; index < frames.length; index += 1) {
    fs.writeFileSync(outFile, frames[index], 'utf-8');
    if (index < frames.length - 1) {
      await sleep(1000);
    }
  }
}

try {
  const resolvedUserText = await resolveProbeUserText({
    boardId,
    cardId,
    turnId,
    logId,
    mcpServerUrl,
    userText,
    lastChatEntryId,
  });
  const probeResponse = buildProbeResponse(resolvedUserText);
  await writeWatchpartyFrames(watchPartyFilesForChatDir, cardId, probeResponse.replyText);
  await sleep(2000);
  await stageAssistantReplyViaMcp(
    boardId,
    cardId,
    turnId,
    probeResponse.replyText,
    probeResponse.files,
    { logId, mcpServerUrl },
  );
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}