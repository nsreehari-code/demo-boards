import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildContext,
  deriveLogIdFromCardId,
  resolveBoardWatchpartyCardDir,
} from '../../../chat-flow/shared.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../logging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD_ROOT = path.resolve(__dirname, '../../../..');
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

export function buildHostedBoardRuntimeNeeds(boardId, boardConfig, hostRuntime) {
  const apiBasePath = `${hostRuntime.apiBasePrefix}/${encodeURIComponent(boardId)}`;
  const chatAgentHandlerNeeds = {
    boardId,
    serverUrl: hostRuntime.serverUrl,
    mcpServerUrl: resolveMcpServerUrl(hostRuntime, apiBasePath),
    apiBasePath,
  };

  const foundryAgents = hostRuntime?.foundryAgents && typeof hostRuntime.foundryAgents === 'object'
    ? hostRuntime.foundryAgents
    : {};
  const boardChat = boardConfig?.chat && typeof boardConfig.chat === 'object' && !Array.isArray(boardConfig.chat)
    ? boardConfig.chat
    : {};
  const boardChatCopilot = boardChat?.copilot && typeof boardChat.copilot === 'object' && !Array.isArray(boardChat.copilot)
    ? boardChat.copilot
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
      chatCopilotTimeoutMs: normalizePositiveInt(hostRuntime?.chatCopilotTimeoutMs, 300000) ?? 300000,
      chatAssistant: normalizeChatAssistant(boardChat?.assistant || boardConfig?.ai),
      copilotCustomWorkspaceStems: Array.isArray(boardChatCopilot['custom-workspace-stems'])
        ? boardChatCopilot['custom-workspace-stems'].filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryChatAgentId: typeof foundryAgents.chatAgentId === 'string' ? foundryAgents.chatAgentId.trim() : '',
      foundryTaskExecutorAgentId: typeof foundryAgents.taskExecutorAgentId === 'string' ? foundryAgents.taskExecutorAgentId.trim() : '',
      foundryChatExposedMcpToolPrefixes: Array.isArray(foundryAgents.chatExposedMcpToolPrefixes)
        ? foundryAgents.chatExposedMcpToolPrefixes.filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
    },
    taskExecutorExtra: {
      aiWorkspaceRoot,
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryTaskExecutorAgentId: typeof foundryAgents.taskExecutorAgentId === 'string' ? foundryAgents.taskExecutorAgentId.trim() : '',
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

  await setChatProcessingState(serverUrl, boardId, cardId, 'started');
  try {
    const invokeAssistant = await loadAssistantInvoker(assistantName);
    executeChatAgentLogger.info(`Invoking ${assistantName}`);
    const context = buildContext(extra);
    fs.rmSync(context.watchPartyDir, { recursive: true, force: true });
    fs.mkdirSync(context.watchPartyDir, { recursive: true });
    const config = { ...extra };
    for (const field of Object.keys(context)) {
      delete config[field];
    }
    await invokeAssistant(context, config);
  } finally {
    try {
      await setChatProcessingState(serverUrl, boardId, cardId, 'done');
    } catch (clearError) {
      console.error(`[execute-chat-agent-request] failed to clear chat-processing for ${boardId}/${cardId}:`, clearError);
    }
  }
}
