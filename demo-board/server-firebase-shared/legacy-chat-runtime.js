import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD_ROOT = path.resolve(__dirname, '..');
const SERVER_CONFIG_PATH = path.resolve(BOARD_ROOT, 'server-config.json');
const DEFAULT_WATCHPARTY_FILES_DIR = 'watchparty-files-for-chat';
const CHAT_FLOW_ROOT = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
const REF_PREFIX = 'b64:';

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

function resolveFromBoardRoot(relativeOrAbsolutePath) {
  if (typeof relativeOrAbsolutePath !== 'string' || !relativeOrAbsolutePath.trim()) return '';
  return path.isAbsolute(relativeOrAbsolutePath)
    ? path.normalize(relativeOrAbsolutePath)
    : path.resolve(BOARD_ROOT, relativeOrAbsolutePath);
}

function serializeRef(ref) {
  return `${REF_PREFIX}${Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url')}`;
}

function normalizeChatAssistant(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'foundry' || normalized === 'probe' || normalized === 'copilot'
    ? normalized
    : 'copilot';
}

function loadServerConfig() {
  return readJsonIfExists(SERVER_CONFIG_PATH) || {};
}

export function loadLegacyBoardChatRuntime(boardId, boardConfig, hostRuntime) {
  const serverConfig = loadServerConfig();
  const boardEntry = serverConfig?.boards && typeof serverConfig.boards === 'object'
    ? serverConfig.boards[boardId]
    : null;
  const apiBasePath = `${hostRuntime.apiBasePrefix}/${encodeURIComponent(boardId)}`;
  const executionExtra = {
    boardId,
    baseRef: boardConfig?.refs?.baseRef ? serializeRef(boardConfig.refs.baseRef) : '',
    cardStoreRef: boardConfig?.refs?.cardStoreRef || '',
    scratchStoreRef: boardConfig?.refs?.scratchStoreRef || '',
    serverUrl: hostRuntime.serverUrl,
    apiBasePath,
    chatFlowRoot: CHAT_FLOW_ROOT,
  };

  if (!boardEntry || typeof boardEntry !== 'object') {
    return { chatHandlerFlow: null, executionExtra };
  }

  const setup = boardEntry.setup && typeof boardEntry.setup === 'object' ? boardEntry.setup : {};
  const regular = boardEntry.regular && typeof boardEntry.regular === 'object' ? boardEntry.regular : {};
  const foundryAgents = serverConfig.foundryAgents && typeof serverConfig.foundryAgents === 'object'
    ? serverConfig.foundryAgents
    : {};
  const watchparty = serverConfig.watchparty && typeof serverConfig.watchparty === 'object'
    ? serverConfig.watchparty
    : {};

  const setupRoot = resolveFromBoardRoot(typeof setup.setupRoot === 'string' ? setup.setupRoot : '');
  const aiWorkspaceRoot = typeof setup.aiWorkspaceRoot === 'string' && setup.aiWorkspaceRoot.trim()
    ? (path.isAbsolute(setup.aiWorkspaceRoot) ? setup.aiWorkspaceRoot : path.resolve(setupRoot, setup.aiWorkspaceRoot))
    : '';
  const watchPartyFilesForChatDir = setupRoot
    ? path.join(setupRoot, typeof watchparty.filesForChatDir === 'string' && watchparty.filesForChatDir.trim()
      ? watchparty.filesForChatDir.trim()
      : DEFAULT_WATCHPARTY_FILES_DIR)
    : '';

  const chatHandlerFlowPath = resolveFromBoardRoot(
    typeof regular.chatHandlerFlowPath === 'string' && regular.chatHandlerFlowPath.trim()
      ? regular.chatHandlerFlowPath.trim()
      : typeof serverConfig.chatHandlerFlowPath === 'string' && serverConfig.chatHandlerFlowPath.trim()
        ? serverConfig.chatHandlerFlowPath.trim()
        : '',
  );

  const chatHandlerFlow = applyFlowTimeout(
    readJsonIfExists(chatHandlerFlowPath),
    serverConfig.chatFlowTimeoutMs,
    serverConfig.chatInvokeRefTimeoutMs,
  );

  return {
    chatHandlerFlow,
    executionExtra: {
      ...executionExtra,
      boardSetupRoot: setupRoot,
      aiWorkspaceRoot,
      watchPartyFilesForChatDir,
      chatCopilotTimeoutMs: normalizePositiveInt(serverConfig.chatCopilotTimeoutMs, 300000) ?? 300000,
      chatAssistant: normalizeChatAssistant(boardEntry?.chat?.assistant),
      foundryEndpoint: typeof foundryAgents.endpoint === 'string' ? foundryAgents.endpoint.trim() : '',
      foundryChatAgentId: typeof foundryAgents.chatAgentId === 'string' ? foundryAgents.chatAgentId.trim() : '',
      foundryChatExposedMcpToolPrefixes: Array.isArray(foundryAgents.chatExposedMcpToolPrefixes)
        ? foundryAgents.chatExposedMcpToolPrefixes.filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
    },
  };
}
