import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStepMachine, MemoryStore, buildStepHandlersForFlow, loadStepFlow } from 'yaml-flow/step-machine-public';
import { invokeExecutionRef } from 'yaml-flow/board-live-cards-node';
import { deriveLogIdFromCardId } from '../../../chat-flow/copilot-chat/watchparty.js';
import { readEnhancedChatMessages } from '../../../chat-flow/copilot-chat/shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD_ROOT = path.resolve(__dirname, '../../../..');

function normalizePositiveInt(value, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function resolveInvokeTimeoutMs(flow) {
  return normalizePositiveInt(flow?.settings?.invoke_timeout_ms, 300000) ?? 300000;
}

function executionWhatToRunValue(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const raw = ref.whatToRun;
  if (raw && typeof raw === 'object' && typeof raw.value === 'string') return raw.value;
  return '';
}

async function runChatHandlerFlow(flowSpec, args) {
  const flow = await loadStepFlow(flowSpec);
  const handlers = buildStepHandlersForFlow(flow, {
    invoke: (ref, stepArgs) => invokeExecutionRef(ref, stepArgs, {
      cliDir: BOARD_ROOT,
      cwd: BOARD_ROOT,
      timeoutMs: resolveInvokeTimeoutMs(flow),
      label: 'chat-handler',
    }),
  });
  const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
  const run = await machine.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {});
  if (run.status !== 'completed') {
    const reason = run.error?.message ?? run.intent ?? run.status;
    return { dispatched: false, error: String(reason || 'flow execution failed') };
  }
  if (run.intent !== 'success') {
    const reason = typeof run.data?.error === 'string'
      ? run.data.error
      : `flow returned intent: ${run.intent}`;
    return { dispatched: false, error: reason };
  }
  return { dispatched: true };
}

async function deriveLastUserText(boardId, cardId, turnId, logId, lastChatEntryId) {
  const messages = await readEnhancedChatMessages(boardId, cardId, 30000, {
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
  });
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (typeof lastChatEntryId === 'string' && lastChatEntryId.trim()) {
    const exactMatch = messages.find((message) => (
      message
      && message.id === lastChatEntryId
      && message.role === 'user'
      && typeof message.text === 'string'
      && message.text.trim()
    ));
    if (exactMatch) return exactMatch.text.trim();
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.text === 'string' && message.text.trim()) {
      return message.text.trim();
    }
  }
  return '';
}

export async function executeChatAgentRequest(request, boardId, chatRuntime) {
  const requestArgs = request && typeof request.args === 'object' && !Array.isArray(request.args)
    ? request.args
    : {};
  const cardId = typeof requestArgs.cardId === 'string' ? requestArgs.cardId.trim() : '';
  const turnId = typeof requestArgs.turnId === 'string' ? requestArgs.turnId.trim() : '';
  const logId = typeof requestArgs.logId === 'string' && requestArgs.logId.trim()
    ? requestArgs.logId.trim()
    : deriveLogIdFromCardId(cardId);
  const userText = typeof requestArgs.userText === 'string' && requestArgs.userText.trim()
    ? requestArgs.userText.trim()
    : await deriveLastUserText(boardId, cardId, turnId, logId, requestArgs.lastChatEntryId);
  const args = {
    ...chatRuntime.executionExtra,
    ...requestArgs,
    ...(cardId ? { cardId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
    ...(userText ? { userText } : {}),
  };

  const ref = request?.ref;
  const result = ref?.howToRun === 'built-in' && executionWhatToRunValue(ref) === 'chat-handler-flow-queue'
    ? await runChatHandlerFlow(chatRuntime.chatHandlerFlow, args)
    : await invokeExecutionRef(ref, args, {
      cliDir: BOARD_ROOT,
      cwd: BOARD_ROOT,
      timeoutMs: 300000,
      label: 'chat-handler',
    }).then((output) => ({
      dispatched: output?.result === 'success',
      error: output?.error,
    }));

  if (!result.dispatched) {
    throw new Error(result.error || `chat-agent dispatch failed for card "${cardId || 'unknown'}"`);
  }
}
