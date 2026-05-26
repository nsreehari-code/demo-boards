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
  stageFinalResponsePayload,
} from './shared.js';
import { getCopilotOutputFileName } from '../../../../../watchparty-constants.mjs';

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
      name: 'probe-generated-summary.txt',
      content: [
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
  aiWorkspaceRoot = '',
  baseRef = '',
  cardStoreRef = '',
  chatStoreRef = '',
  artifactsStoreRef = '',
  cardId = '',
  scratchStoreRef = '',
  userText = '',
  watchPartyFilesForChatDir = '',
} = extra;

requireRequiredStrings({
  aiWorkspaceRoot,
  baseRef,
  cardStoreRef,
  chatStoreRef,
  artifactsStoreRef,
  cardId,
  scratchStoreRef,
  userText,
  watchPartyFilesForChatDir,
}, 'probe');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeWatchpartyFrames(dirPath, cId, replyText) {
  const outFile = path.join(dirPath, getCopilotOutputFileName(cId));
  const frames = [
    "Assistant's Output:\n",
    "Assistant's Output:\nprobe frame 1\n",
    "Assistant's Output:\nprobe frame 1\nprobe frame 2\n",
    `Assistant's Output:\nprobe frame 1\nprobe frame 2\n${replyText}\n`,
  ];

  fs.mkdirSync(dirPath, { recursive: true });
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
  appendSystemMessage(chatStoreRef, cardId, 'in-progress');
  const probeResponse = buildProbeResponse(userText);
  const finalResponseContainer = createFinalResponseContainer(scratchStoreRef, cardId, 'probe-final-response');
  stageFinalResponsePayload(finalResponseContainer.containerDir, {
    text: probeResponse.replyText,
    files: probeResponse.files,
  });
  await writeWatchpartyFrames(watchPartyFilesForChatDir, cardId, probeResponse.replyText);
  publishFinalResponseFromContainer({
    baseRef,
    chatStoreRef,
    cardStoreRef,
    artifactsStoreRef,
    cardId,
    finalResponseContainerRef: finalResponseContainer.containerRef,
    containerDir: finalResponseContainer.containerDir,
    replyText: probeResponse.replyText,
  });
  // The flow only consumes success or error from this process. Reply text must not be returned here.
  process.stdout.write(JSON.stringify({ assistantHandled: true }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}