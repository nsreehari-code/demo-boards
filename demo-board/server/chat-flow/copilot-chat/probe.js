#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  appendSystemMessage,
  configureWorkspaceCliScripts,
  createFinalResponseContainer,
  publishFinalResponseFromContainer,
  readJsonStdin,
  requireRequiredStrings,
  resolveCopilotWorkspaceDir,
  stageAssistantReplyViaMcp,
  stageFinalResponsePayload,
} from './shared.js';
import { getAgentOutputFileName } from './watchparty.js';

const PROBE_MARKER = '__probe__echo__probe__';
const PROBE_ATTACHMENT_PREFIX = '[attach]';

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

const extra = readJsonStdin();
const {
  boardId = '',
  baseRef = '',
  aiWorkspaceRoot = '',
  cardStoreRef = '',
  chatStoreRef = '',
  artifactsStoreRef = '',
  cardId = '',
  logId = '',
  scratchStoreRef = '',
  turnId = '',
  userText = '',
  watchPartyFilesForChatDir = '',
} = extra;

requireRequiredStrings({
  aiWorkspaceRoot,
  cardStoreRef,
  chatStoreRef,
  cardId,
  logId,
  userText,
  watchPartyFilesForChatDir,
}, 'probe');

function canUseManagedFinalResponseFlow() {
  return [baseRef, artifactsStoreRef, scratchStoreRef, turnId].every(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

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
  const workingDir = resolveCopilotWorkspaceDir(aiWorkspaceRoot, cardStoreRef, cardId, 'probe');
  configureWorkspaceCliScripts(workingDir, 'probe');
  appendSystemMessage(chatStoreRef, cardId, 'in-progress', 30000, turnId);
  const probeResponse = buildProbeResponse(userText);
  await writeWatchpartyFrames(watchPartyFilesForChatDir, cardId, probeResponse.replyText);
  if (canUseManagedFinalResponseFlow()) {
    const { containerDir } = createFinalResponseContainer(scratchStoreRef, cardId, 'probe-final-response');
    stageFinalResponsePayload(containerDir, {
      text: probeResponse.replyText,
      files: probeResponse.files,
    });
    publishFinalResponseFromContainer({
      baseRef,
      chatStoreRef,
      artifactsStoreRef,
      cardId,
      containerDir,
      replyText: probeResponse.replyText,
      turnId,
    });
  } else {
    await stageAssistantReplyViaMcp(
      boardId,
      cardId,
      turnId,
      probeResponse.replyText,
      probeResponse.files,
      { logId },
    );
  }
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}