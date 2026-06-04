import fs from 'node:fs';
import path from 'node:path';

const REF_PREFIX = 'b64:';
const BOARD_REF_FIELDS = Object.freeze([
  'boardRuntimeStoreRef',
  'cardStoreRef',
  'outputsStoreRef',
  'queueStoreRef',
  'scratchStoreRef',
  'archiveStoreRef',
  'chatStoreRef',
  'artifactsStoreRef',
  'fetchedSourcesStoreRef',
]);

function toBase64Url(raw) {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function serializeKindValueRef(ref) {
  return `${REF_PREFIX}${toBase64Url(JSON.stringify(ref))}`;
}

function tryParseKindValueRef(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith(REF_PREFIX)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(trimmed.slice(REF_PREFIX.length), 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const kind = typeof parsed.kind === 'string' ? parsed.kind.trim() : '';
      const refValue = typeof parsed.value === 'string' ? parsed.value.trim() : '';
      return kind && refValue ? { kind, value: refValue } : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
    const refValue = typeof value.value === 'string' ? value.value.trim() : '';
    return kind && refValue ? { kind, value: refValue } : null;
  }
  return null;
}

function normalizeStoreRefConfig(value) {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (trimmed.startsWith(REF_PREFIX)) {
      const parsed = tryParseKindValueRef(trimmed);
      return parsed ? serializeKindValueRef(parsed) : undefined;
    }
    return trimmed;
  }
  const parsed = tryParseKindValueRef(value);
  return parsed ? serializeKindValueRef(parsed) : undefined;
}

function replaceBoardTemplate(value, boardId) {
  return String(value).replace(/\{\{\s*boardId\s*\}\}/g, String(boardId));
}

function resolveBoardRefs(boardId, refsConfig) {
  const source = refsConfig && typeof refsConfig === 'object' ? refsConfig : null;
  if (!source) return undefined;

  const refs = {};
  const baseRef = tryParseKindValueRef(source.baseRef);
  if (baseRef) {
    refs.baseRef = {
      kind: baseRef.kind,
      value: replaceBoardTemplate(baseRef.value, boardId),
    };
  }
  for (const field of BOARD_REF_FIELDS) {
    const normalized = normalizeStoreRefConfig(source[field]);
    if (!normalized) continue;
    const parsed = tryParseKindValueRef(normalized);
    refs[field] = parsed
      ? serializeKindValueRef({ kind: parsed.kind, value: replaceBoardTemplate(parsed.value, boardId) })
      : replaceBoardTemplate(normalized, boardId);
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function mergeConfigObjects(base, override) {
  const left = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const right = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  return {
    ...left,
    ...right,
    firebase: {
      ...((left.firebase && typeof left.firebase === 'object' && !Array.isArray(left.firebase)) ? left.firebase : {}),
      ...((right.firebase && typeof right.firebase === 'object' && !Array.isArray(right.firebase)) ? right.firebase : {}),
    },
    localfs: {
      ...((left.localfs && typeof left.localfs === 'object' && !Array.isArray(left.localfs)) ? left.localfs : {}),
      ...((right.localfs && typeof right.localfs === 'object' && !Array.isArray(right.localfs)) ? right.localfs : {}),
    },
  };
}

function resolveProcessConfig(config, processName) {
  if (!processName) return config;
  const processConfig = config?.[processName];
  if (!processConfig || typeof processConfig !== 'object' || Array.isArray(processConfig)) {
    return config;
  }
  const {
    controlface: _omitControlface,
    queueRunner: _omitQueueRunner,
    ...sharedConfig
  } = config;
  return mergeConfigObjects(sharedConfig, processConfig);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseCliConfigPath(defaultConfigPath, cliArgs = process.argv.slice(2)) {
  const configFlagIndex = cliArgs.indexOf('--config');
  const configuredPath = configFlagIndex >= 0 ? cliArgs[configFlagIndex + 1] : '';
  if (!configuredPath || !String(configuredPath).trim()) {
    return defaultConfigPath;
  }
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(process.cwd(), configuredPath);
}

function buildBoardConfigs(config) {
  const boardsSource = config?.boards;
  if (!boardsSource || typeof boardsSource !== 'object' || Array.isArray(boardsSource)) {
    throw new Error('Config requires a boards object');
  }

  const boards = {};
  for (const [boardId, boardConfig] of Object.entries(boardsSource)) {
    const normalizedBoardId = requireNonEmptyString(boardId, 'board id');
    const source = boardConfig && typeof boardConfig === 'object' && !Array.isArray(boardConfig)
      ? boardConfig
      : {};
    boards[normalizedBoardId] = {
      id: normalizedBoardId,
      label: typeof source.label === 'string' && source.label.trim() ? source.label.trim() : normalizedBoardId,
      refs: resolveBoardRefs(normalizedBoardId, source.refs),
      taskExecutorModule: typeof source.taskExecutorModule === 'string' && source.taskExecutorModule.trim()
        ? source.taskExecutorModule.trim()
        : '',
      chat: source.chat && typeof source.chat === 'object' && !Array.isArray(source.chat)
        ? source.chat
        : {},
      setup: source.setup && typeof source.setup === 'object' && !Array.isArray(source.setup)
        ? source.setup
        : {},
      regular: source.regular && typeof source.regular === 'object' && !Array.isArray(source.regular)
        ? source.regular
        : {},
      'copilot-workdirs-setup': Array.isArray(source['copilot-workdirs-setup'])
        ? source['copilot-workdirs-setup'].filter((entry) => entry && typeof entry === 'object')
        : [],
      queueWakeup: source.queueWakeup && typeof source.queueWakeup === 'object' && !Array.isArray(source.queueWakeup)
        ? source.queueWakeup
        : {},
    };
  }

  if (Object.keys(boards).length === 0) {
    throw new Error('Config requires at least one board');
  }

  return boards;
}

export function loadFirebaseHostConfig(defaultConfigPath, cliArgs = process.argv.slice(2), processName = '') {
  const configPath = parseCliConfigPath(defaultConfigPath, cliArgs);
  const rawConfig = readJsonFile(configPath);
  const config = resolveProcessConfig(rawConfig, processName);
  const configDir = path.dirname(configPath);
  const boards = buildBoardConfigs(config);

  return {
    configPath,
    configDir,
    storageAdapter: typeof config.storageAdapter === 'string' && config.storageAdapter.trim()
      ? config.storageAdapter.trim().toLowerCase()
      : 'firebase',
    host: typeof config.host === 'string' && config.host.trim() ? config.host.trim() : '127.0.0.1',
    port: Number.isFinite(Number(config.port)) ? Number(config.port) : 7810,
    mcpServerUrl: typeof config.mcpServerUrl === 'string' && config.mcpServerUrl.trim()
      ? config.mcpServerUrl.trim()
      : '',
    serverOrigin: typeof config.serverOrigin === 'string' && config.serverOrigin.trim()
      ? config.serverOrigin.trim().replace(/\/$/, '')
      : '',
    apiBasePrefix: typeof config.apiBasePrefix === 'string' && config.apiBasePrefix.trim()
      ? config.apiBasePrefix.trim().replace(/\/$/, '')
      : '/api/boards',
    chatFlowTimeoutMs: Number.isFinite(Number(config.chatFlowTimeoutMs)) ? Number(config.chatFlowTimeoutMs) : undefined,
    chatInvokeRefTimeoutMs: Number.isFinite(Number(config.chatInvokeRefTimeoutMs)) ? Number(config.chatInvokeRefTimeoutMs) : undefined,
    chatCopilotTimeoutMs: Number.isFinite(Number(config.chatCopilotTimeoutMs)) ? Number(config.chatCopilotTimeoutMs) : undefined,
    watchparty: config.watchparty && typeof config.watchparty === 'object' && !Array.isArray(config.watchparty)
      ? config.watchparty
      : {},
    foundryAgents: config.foundryAgents && typeof config.foundryAgents === 'object' && !Array.isArray(config.foundryAgents)
      ? config.foundryAgents
      : {},
    firebase: config.firebase && typeof config.firebase === 'object' && !Array.isArray(config.firebase)
      ? config.firebase
      : {},
    boards,
  };
}

export function resolveConfigRelativePath(configDir, relativeOrAbsolutePath) {
  const normalized = requireNonEmptyString(relativeOrAbsolutePath, 'relative path');
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(configDir, normalized);
}
