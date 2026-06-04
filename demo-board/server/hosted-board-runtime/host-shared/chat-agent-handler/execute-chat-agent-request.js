import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStepMachine, MemoryStore, buildStepHandlersForFlow, loadStepFlow } from 'yaml-flow/step-machine-public';
import { invokeStepMachineExecutionRef } from 'yaml-flow/board-worker-adapter';
import { deriveLogIdFromCardId } from '../../../chat-flow/copilot-chat/watchparty.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD_ROOT = path.resolve(__dirname, '../../../..');
const DEFAULT_WATCHPARTY_FILES_DIR = 'watchparty-files-for-chat';
const CHAT_FLOW_ROOT = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:7801/mcp';

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function normalizePositiveInt(value, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function normalizeNonNegativeInt(value, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function applyFlowTimeout(flow, timeoutMs, invokeTimeoutMs) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return null;
  const normalizedTimeoutMs = normalizePositiveInt(timeoutMs, null);
  const normalizedInvokeTimeoutMs = normalizeNonNegativeInt(invokeTimeoutMs, null);
  if (normalizedTimeoutMs === null && normalizedInvokeTimeoutMs === null) return flow;
  return {
    ...flow,
    settings: {
      ...(flow.settings && typeof flow.settings === 'object' ? flow.settings : {}),
      ...(normalizedTimeoutMs !== null ? { timeout_ms: normalizedTimeoutMs } : {}),
      ...(normalizedInvokeTimeoutMs !== null ? { invoke_timeout_ms: normalizedInvokeTimeoutMs } : {}),
    },
  };
}

function resolveFromConfigBase(configDir, relativeOrAbsolutePath) {
  if (typeof relativeOrAbsolutePath !== 'string' || !relativeOrAbsolutePath.trim()) return '';
  return path.isAbsolute(relativeOrAbsolutePath)
    ? path.normalize(relativeOrAbsolutePath)
    : path.resolve(configDir || BOARD_ROOT, relativeOrAbsolutePath);
}

function normalizeChatAssistant(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'foundry' || normalized === 'probe' || normalized === 'copilot'
    ? normalized
    : 'copilot';
}

function normalizeWorkspaceStems(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim() : '';
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

function resolveInvokeTimeoutMs(flow) {
  return normalizePositiveInt(flow?.settings?.invoke_timeout_ms, 300000) ?? 300000;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimTrailingSlash(value) {
  return normalizeString(value).replace(/\/+$/, '');
}

function normalizeBoolean(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function normalizeProbe(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveProbeAssistantOverride(probe) {
  const normalized = normalizeProbe(probe);
  if (!normalized) return '';
  return normalized === 'echo' ? 'probe' : normalized;
}

function resolveMcpServerUrl(hostRuntime, apiBasePath = '') {
  const hostedServerUrl = trimTrailingSlash(hostRuntime?.serverUrl);
  const normalizedApiBasePath = normalizeString(apiBasePath);
  if (hostedServerUrl && normalizedApiBasePath) {
    return `${hostedServerUrl}${normalizedApiBasePath}/mcp`;
  }
  const envOverride = typeof process.env.DEMO_BOARDS_MCP_SERVER_URL === 'string'
    ? process.env.DEMO_BOARDS_MCP_SERVER_URL.trim()
    : '';
  const configuredUrl = typeof hostRuntime?.mcpServerUrl === 'string'
    ? hostRuntime.mcpServerUrl.trim()
    : '';
  return envOverride || configuredUrl || DEFAULT_MCP_SERVER_URL;
}

export function buildHostedChatAgentRuntime(boardId, boardConfig, hostRuntime) {
  const configBaseDir = typeof hostRuntime?.configDir === 'string' && hostRuntime.configDir.trim()
    ? hostRuntime.configDir.trim()
    : BOARD_ROOT;
  const apiBasePath = `${hostRuntime.apiBasePrefix}/${encodeURIComponent(boardId)}`;
  const chat = boardConfig?.chat && typeof boardConfig.chat === 'object' ? boardConfig.chat : {};
  const copilotChat = chat?.copilot && typeof chat.copilot === 'object' && !Array.isArray(chat.copilot)
    ? chat.copilot
    : {};
  const executionExtra = {
    boardId,
    serverUrl: hostRuntime.serverUrl,
    mcpServerUrl: resolveMcpServerUrl(hostRuntime, apiBasePath),
    apiBasePath,
    chatFlowRoot: CHAT_FLOW_ROOT,
  };

  const setup = boardConfig?.setup && typeof boardConfig.setup === 'object' ? boardConfig.setup : {};
  const regular = boardConfig?.regular && typeof boardConfig.regular === 'object' ? boardConfig.regular : {};
  const foundryAgents = hostRuntime?.foundryAgents && typeof hostRuntime.foundryAgents === 'object'
    ? hostRuntime.foundryAgents
    : {};
  const watchparty = hostRuntime?.watchparty && typeof hostRuntime.watchparty === 'object'
    ? hostRuntime.watchparty
    : {};

  const setupRoot = resolveFromConfigBase(configBaseDir, typeof setup.setupRoot === 'string' ? setup.setupRoot : '');
  const aiWorkspaceRoot = typeof setup.aiWorkspaceRoot === 'string' && setup.aiWorkspaceRoot.trim()
    ? (path.isAbsolute(setup.aiWorkspaceRoot) ? setup.aiWorkspaceRoot : path.resolve(setupRoot, setup.aiWorkspaceRoot))
    : '';
  const watchPartyFilesForChatDir = setupRoot
    ? path.join(setupRoot, typeof watchparty.filesForChatDir === 'string' && watchparty.filesForChatDir.trim()
      ? watchparty.filesForChatDir.trim()
      : DEFAULT_WATCHPARTY_FILES_DIR)
    : '';

  const chatHandlerFlowPath = resolveFromConfigBase(
    configBaseDir,
    typeof regular.chatHandlerFlowPath === 'string' && regular.chatHandlerFlowPath.trim()
      ? regular.chatHandlerFlowPath.trim()
      : '',
  );

  const chatHandlerFlow = applyFlowTimeout(
    readJsonIfExists(chatHandlerFlowPath),
    hostRuntime?.chatFlowTimeoutMs,
    hostRuntime?.chatInvokeRefTimeoutMs,
  );

  return {
    chatHandlerFlow,
    executionExtra: {
      ...executionExtra,
      boardSetupRoot: setupRoot,
      aiWorkspaceRoot,
      watchPartyFilesForChatDir,
      chatCopilotTimeoutMs: normalizePositiveInt(hostRuntime?.chatCopilotTimeoutMs, 300000) ?? 300000,
      chatAssistant: normalizeChatAssistant(chat?.assistant),
      copilotCustomWorkspaceStems: normalizeWorkspaceStems(copilotChat['custom-workspace-stems']),
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryChatAgentId: typeof foundryAgents.chatAgentId === 'string' ? foundryAgents.chatAgentId.trim() : '',
      foundryChatExposedMcpToolPrefixes: Array.isArray(foundryAgents.chatExposedMcpToolPrefixes)
        ? foundryAgents.chatExposedMcpToolPrefixes.filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
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

async function runChatHandlerFlow(flowSpec, args) {
  const flow = await loadStepFlow(flowSpec);
  const handlers = buildStepHandlersForFlow(flow, {
    invoke: (ref, stepArgs) => invokeStepMachineExecutionRef(ref, stepArgs, {
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

export async function executeChatAgentRequest(request, boardId, chatRuntime) {
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
  const args = {
    ...chatRuntime.executionExtra,
    ...requestArgs,
    ...(cardId ? { cardId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(logId ? { logId } : {}),
    ...(probe ? { probe } : {}),
    ...(probeAssistantOverride ? { chatAssistant: probeAssistantOverride } : {}),
  };

  const result = await runChatHandlerFlow(chatRuntime.chatHandlerFlow, args);

  if (!result.dispatched) {
    throw new Error(result.error || `chat-agent dispatch failed for card "${cardId || 'unknown'}"`);
  }
}
