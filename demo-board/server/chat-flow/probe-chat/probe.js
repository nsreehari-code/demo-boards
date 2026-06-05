import {
  getEnhancedChatMessages,
  invokeMcpServerTool,
} from '../shared.js';

const FILE_INDEX_PATTERN = /#(\d+)\s*$/;
const ATTACHMENT_MARKER = '[attachment]';

async function stageProbeReply({ context, text, files }) {
  const payload = await invokeMcpServerTool(context, 'liveboards.stage-ai-response-and-any-attachments', {
    board_id: context.boardId,
    card_id: context.cardId,
    turn_id: context.turnId,
    log_id: context.logId,
    text,
    files: Array.isArray(files) ? files : [],
  });
  if (payload?.status !== 'success') {
    const errorText = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : 'liveboards.stage-ai-response-and-any-attachments failed';
    throw new Error(errorText);
  }
  return payload.data;
}

function stripAttachmentMarker(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.split(ATTACHMENT_MARKER).join('').replace(/\s{2,}/g, ' ').trim();
}

function shouldUseAttachmentResponse(text) {
  return typeof text === 'string' && text.includes(ATTACHMENT_MARKER);
}

function normalizeProbe(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function findLatestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.text === 'string' && message.text.trim()) {
      return message.text.trim();
    }
  }
  return '';
}

function parseFileIndexFromMessage(message) {
  const retrievalHint = typeof message?.retrieval_hint === 'string'
    ? message.retrieval_hint.trim()
    : typeof message?.payload?.retrieval_hint === 'string'
      ? message.payload.retrieval_hint.trim()
      : '';
  const retrievalMatch = /file_idx\s+(\d+)\b/i.exec(retrievalHint);
  if (retrievalMatch) {
    return Number.parseInt(retrievalMatch[1], 10);
  }

  const messageText = typeof message?.text === 'string'
    ? message.text.trim()
    : typeof message?.payload?.text === 'string'
      ? message.payload.text.trim()
      : '';
  const textMatch = FILE_INDEX_PATTERN.exec(messageText);
  if (textMatch) {
    return Number.parseInt(textMatch[1], 10);
  }

  return null;
}

function findLatestAttachmentFileIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'system') {
      continue;
    }
    const fileIndex = parseFileIndexFromMessage(message);
    if (Number.isInteger(fileIndex) && fileIndex >= 0) {
      return fileIndex;
    }
  }
  return null;
}

function extractFileContents(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  if (typeof payload.text === 'string') {
    return payload.text;
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  if (typeof payload.body === 'string') {
    return payload.body;
  }
  return '';
}

async function readProbeAttachmentContents(context, fileIndex) {
  const payload = await invokeMcpServerTool(context, 'liveboards.inspect.file-contents', {
    board_id: context.boardId,
    card_id: context.cardId,
    turn_id: context.turnId,
    log_id: context.logId,
    file_idx: fileIndex,
  });
  if (payload?.status !== 'success') {
    const errorText = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : 'liveboards.inspect.file-contents failed';
    throw new Error(errorText);
  }
  const text = extractFileContents(payload.data);
  if (!text.trim()) {
    throw new Error(`Probe attachment ${fileIndex} did not return text content`);
  }
  return text;
}

async function resolveProbeResponseText(context, config = {}) {
  const messages = await getEnhancedChatMessages(context);
  const userText = findLatestUserMessage(messages);
  if (!userText) {
    throw new Error('Missing required probe input: userText');
  }
  const strippedMessageText = stripAttachmentMarker(userText);
  const probeMode = normalizeProbe(config?.probe);

  if (!probeMode) {
    throw new Error('Missing required probe input: probe');
  }

  if (probeMode === 'echo') {
    return `Echo: ${strippedMessageText}`;
  }

  if (probeMode !== 'echoattach') {
    throw new Error(`Unsupported probe mode: ${probeMode}`);
  }

  const fileIndex = findLatestAttachmentFileIndex(messages);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    throw new Error('Missing required probe input: attachment system message');
  }

  return await readProbeAttachmentContents(context, fileIndex);
}

export async function invokeAssistant(context, config = {}) {
  const probeResponseText = await resolveProbeResponseText(context, config);
  await stageProbeReply({
    context,
    text: probeResponseText,
    files: [],
  });
  return { assistantHandled: true };
}
