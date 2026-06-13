import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  AGENT_OUTPUT_FILE_STEM,
  buildContext,
  deriveLogIdFromCardId,
  isAssistantMessageInTurn,
  resolveBoardWatchpartyCardDir,
} from '../../../chat-flow/shared.js';
import { deriveBoardRootFromModuleUrl } from '../../../shared/board-root.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../logging.js';

const BOARD_ROOT = deriveBoardRootFromModuleUrl(import.meta.url, '../../..');
const CHAT_FLOW_ROOT = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
const ASSISTANT_REGISTRY_PATH = path.resolve(CHAT_FLOW_ROOT, 'assistant_registry.json');
const ASSISTANT_REGISTRY = JSON.parse(fs.readFileSync(ASSISTANT_REGISTRY_PATH, 'utf8'));
const executeChatAgentLogger = createLogger('execute-chat-agent-handler', { filePath: HOSTED_SERVER_LOG_PATH });

const assistantModuleCache = new Map();

async function loadAssistantInvoker(name) {
  if (assistantModuleCache.has(name)) {
    return assistantModuleCache.get(name);
  }
  const relativePath = ASSISTANT_REGISTRY[name];
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`Unknown chat assistant: "${name}". Registered: ${Object.keys(ASSISTANT_REGISTRY).join(', ')}`);
  }
  const absolutePath = path.resolve(CHAT_FLOW_ROOT, relativePath);
  const mod = await import(pathToFileURL(absolutePath).href);
  if (typeof mod.invokeAssistant !== 'function') {
    throw new Error(`Chat assistant "${name}" at ${relativePath} does not export invokeAssistant()`);
  }
  assistantModuleCache.set(name, mod.invokeAssistant);
  return mod.invokeAssistant;
}

function normalizePositiveInt(value, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function normalizeChatAssistant(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'foundry' || normalized === 'probe' || normalized === 'copilot'
    ? normalized
    : 'copilot';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingSlash(value) {
  return normalizeString(value).replace(/\/+$/, '');
}

function normalizeProbe(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveProbeAssistantOverride(probe) {
  const normalized = normalizeProbe(probe);
  if (!normalized) return '';
  if (normalized === 'echo' || normalized === 'echoattach') {
    return 'probe';
  }
  return normalized;
}

function resolveMcpServerUrl(hostRuntime, _apiBasePath = '') {
  return normalizeString(hostRuntime?.mcpServerUrl);
}

function resolveAgentFaceMcpPath(hostRuntime) {
  const raw = normalizeString(hostRuntime?.agentFaceMcp) || '/agent/mcp';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveNotifyUrl(hostRuntime, apiBasePath) {
  const explicitNotifyUrl = normalizeString(hostRuntime?.notifyUrl);
  if (explicitNotifyUrl) {
    return explicitNotifyUrl;
  }
  const notifyServerUrl = trimTrailingSlash(hostRuntime?.notifyServerUrl || hostRuntime?.serverUrl);
  return notifyServerUrl && apiBasePath
    ? `${notifyServerUrl}${apiBasePath}/notify-q`
    : '';
}

export function buildHostedBoardRuntimeNeeds(boardId, boardConfig, hostRuntime) {
  const apiBasePath = `${hostRuntime.apiBasePrefix}/${encodeURIComponent(boardId)}`;
  const chatAgentHandlerNeeds = {
    boardId,
    serverUrl: hostRuntime.serverUrl,
    notifyUrl: resolveNotifyUrl(hostRuntime, apiBasePath),
    mcpServerUrl: resolveMcpServerUrl(hostRuntime, apiBasePath),
    agentFaceMcp: resolveAgentFaceMcpPath(hostRuntime),
    apiBasePath,
  };

  const foundryAgents = hostRuntime?.foundryAgents && typeof hostRuntime.foundryAgents === 'object'
    ? hostRuntime.foundryAgents
    : {};

  const aiWorkspaceRoot = typeof boardConfig?.aiWorkspaceRoot === 'string' && boardConfig.aiWorkspaceRoot.trim()
    ? path.normalize(boardConfig.aiWorkspaceRoot.trim())
    : '';
  if (aiWorkspaceRoot && !path.isAbsolute(aiWorkspaceRoot)) {
    throw new Error(`boards.${boardId}.aiWorkspaceRoot must be an absolute path (got '${aiWorkspaceRoot}')`);
  }

  return {
    chatAgentHandlerNeeds: {
      ...chatAgentHandlerNeeds,
      streamableMcpServerUrl: typeof hostRuntime?.mcpServerUrl === 'string' ? hostRuntime.mcpServerUrl.trim() : '',
      enableAssistantDebug: hostRuntime?.enableAssistantDebug === true,
      debugAssistantFile: typeof hostRuntime?.debugAssistantFile === 'string' ? hostRuntime.debugAssistantFile.trim() : '',
      aiWorkspaceRoot,
      chatCopilotTimeoutMs: normalizePositiveInt(hostRuntime?.chatCopilotTimeoutMs, 2100000) ?? 2100000,
        chatAssistant: normalizeChatAssistant(boardConfig?.ai),
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryChatAgentId: typeof foundryAgents.chatAgentId === 'string' ? foundryAgents.chatAgentId.trim() : '',
      foundryTaskExecutorAgentId: typeof foundryAgents.taskExecutorAgentId === 'string' ? foundryAgents.taskExecutorAgentId.trim() : '',
      foundryChatExposedMcpToolPrefixes: Array.isArray(foundryAgents.chatExposedMcpToolPrefixes)
        ? foundryAgents.chatExposedMcpToolPrefixes.filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
      watchpartyFileRegistry: hostRuntime?.watchpartyFileRegistry || null,
    },
    taskExecutorExtra: {
      boardId,
      aiWorkspaceRoot,
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryTaskExecutorAgentId: typeof foundryAgents.taskExecutorAgentId === 'string' ? foundryAgents.taskExecutorAgentId.trim() : '',
      taskExecutorTimeoutMs: normalizePositiveInt(hostRuntime?.taskExecutorTimeoutMs, null)
        ?? normalizePositiveInt(hostRuntime?.chatCopilotTimeoutMs, 2100000)
        ?? 2100000,
    },
  };
}

function deriveTurnId(requestArgs) {
  const directTurnId = normalizeString(requestArgs?.turnId)
    || normalizeString(requestArgs?.turn_id)
    || normalizeString(requestArgs?.['turn-id'])
    || normalizeString(requestArgs?.turn);
  return directTurnId || `hosted-turn-${randomUUID()}`;
}

async function setChatProcessingState(serverUrl, boardId, cardId, state) {
  const tool = state === 'started' ? 'setstate.chat-processing-started' : 'setstate.chat-processing-done';
  const url = `${serverUrl.replace(/\/$/, '')}/api/boards/${encodeURIComponent(boardId)}/mcp-controlplane`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args: { board_id: boardId, card_id: cardId } }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status === 'fail' || payload?.status === 'error') {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `Failed to set chat processing state to ${state}`;
    throw new Error(message);
  }
}

async function waitForAssistantReplyVisible(serverUrl, boardId, cardId, turnId, options = {}) {
  const {
    stopSignal = null,
    pollMs = 500,
    timeoutMs = 2100000,
  } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (stopSignal?.stopped === true) {
      return false;
    }
    try {
      if (await isAssistantMessageInTurn({ serverUrl, boardId, cardId, turnId })) {
        return true;
      }
    } catch {
      // Best-effort only; the final cleanup path still clears processing.
    }
    await sleep(pollMs);
  }

  return false;
}

export async function executeChatAgentRequest(request, boardId, boardRuntimeNeeds) {
  const requestArgs = request && typeof request.args === 'object' && !Array.isArray(request.args)
    ? request.args
    : {};
  const cardId = normalizeString(requestArgs.cardId) || normalizeString(requestArgs.card_id);
  const turnId = deriveTurnId(requestArgs);
  const logId = normalizeString(requestArgs.logId) || normalizeString(requestArgs.log_id)
    ? (normalizeString(requestArgs.logId) || normalizeString(requestArgs.log_id))
    : deriveLogIdFromCardId(cardId);
  const probe = normalizeProbe(requestArgs.probe);
  const probeAssistantOverride = resolveProbeAssistantOverride(probe);
  const watchPartyDir = cardId
    ? resolveBoardWatchpartyCardDir(boardId, cardId)
    : '';
  const extra = {
    ...boardRuntimeNeeds.chatAgentHandlerNeeds,
    ...requestArgs,
    ...(cardId ? { cardId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
    ...(probe ? { probe } : {}),
    ...(probeAssistantOverride ? { chatAssistant: probeAssistantOverride } : {}),
    ...(watchPartyDir ? { watchPartyDir } : {}),
  };

  const serverUrl = normalizeString(boardRuntimeNeeds?.chatAgentHandlerNeeds?.serverUrl);
  if (!serverUrl) {
    throw new Error('chat-agent dispatch requires boardRuntimeNeeds.chatAgentHandlerNeeds.serverUrl');
  }
  if (!cardId) {
    throw new Error('chat-agent dispatch requires cardId');
  }

  const assistantName = normalizeChatAssistant(extra.chatAssistant);
  const watchpartyFileRegistry = boardRuntimeNeeds?.chatAgentHandlerNeeds?.watchpartyFileRegistry;
  const notifyUrl = normalizeString(boardRuntimeNeeds?.chatAgentHandlerNeeds?.notifyUrl);
  const assistantTimeoutMs = normalizePositiveInt(extra.chatCopilotTimeoutMs, 2100000) ?? 2100000;
  let processingCleared = false;
  const replyVisibleMonitorState = { stopped: false };

  async function clearChatProcessing() {
    if (processingCleared) {
      return;
    }
    await setChatProcessingState(serverUrl, boardId, cardId, 'done');
    processingCleared = true;
  }

  await setChatProcessingState(serverUrl, boardId, cardId, 'started');
  const replyVisibleMonitorPromise = waitForAssistantReplyVisible(serverUrl, boardId, cardId, turnId, {
    stopSignal: replyVisibleMonitorState,
    timeoutMs: assistantTimeoutMs,
  }).then(async (replyVisible) => {
    if (!replyVisible) {
      return;
    }
    try {
      await clearChatProcessing();
    } catch (clearError) {
      console.error(`[execute-chat-agent-request] failed to clear chat-processing early for ${boardId}/${cardId}:`, clearError);
    }
  });
  try {
    const invokeAssistant = await loadAssistantInvoker(assistantName);
    executeChatAgentLogger.info(`Invoking ${assistantName}`);
    const context = buildContext(extra);
    fs.rmSync(context.watchPartyDir, { recursive: true, force: true });
    fs.mkdirSync(context.watchPartyDir, { recursive: true });
    const unregisterAgentOutputWatchparty = typeof watchpartyFileRegistry?.registerWatchpartyFile === 'function'
      ? await watchpartyFileRegistry.registerWatchpartyFile({
          filePath: path.join(context.watchPartyDir, AGENT_OUTPUT_FILE_STEM),
          notifyUrl,
          cardId,
          channel: 'agent-output',
          clearOnRegister: true,
          replace: false,
        })
      : null;
    const config = { ...extra };
    for (const field of Object.keys(context)) {
      delete config[field];
    }
    try {
      await invokeAssistant(context, config);
    } finally {
      if (typeof unregisterAgentOutputWatchparty === 'function') {
        await unregisterAgentOutputWatchparty();
      }
    }
  } finally {
    replyVisibleMonitorState.stopped = true;
    await replyVisibleMonitorPromise.catch(() => {});
    try {
      await clearChatProcessing();
    } catch (clearError) {
      console.error(`[execute-chat-agent-request] failed to clear chat-processing for ${boardId}/${cardId}:`, clearError);
    }
  }
}
