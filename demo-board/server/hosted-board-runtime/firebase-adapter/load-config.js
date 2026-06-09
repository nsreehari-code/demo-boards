import fs from 'node:fs';
import path from 'node:path';
import { deriveBoardRootFromConfigDir } from '../../shared/board-root.js';

const REF_PREFIX = 'b64:';
const SHARED_TEMPLATES_CONFIG_NAME = 'templates-config.json';
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

function replaceTemplateTokens(value, tokens) {
  return String(value).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : match
  );
}

function deriveBoardRoot(configDir) {
  return deriveBoardRootFromConfigDir(configDir);
}

function resolveBoardRefs(boardId, refsConfig, tokens) {
  const source = refsConfig && typeof refsConfig === 'object' ? refsConfig : null;
  if (!source) return undefined;

  const refs = {};
  const baseRef = tryParseKindValueRef(source.baseRef);
  if (baseRef) {
    refs.baseRef = {
      kind: baseRef.kind,
      value: replaceTemplateTokens(baseRef.value, tokens),
    };
  }
  for (const field of BOARD_REF_FIELDS) {
    const normalized = normalizeStoreRefConfig(source[field]);
    if (!normalized) continue;
    const parsed = tryParseKindValueRef(normalized);
    refs[field] = parsed
      ? serializeKindValueRef({ kind: parsed.kind, value: replaceTemplateTokens(parsed.value, tokens) })
      : replaceTemplateTokens(normalized, tokens);
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

function mergeNamedObjectField(left, right, fieldName) {
  const leftValue = left?.[fieldName];
  const rightValue = right?.[fieldName];
  const normalizedLeft = leftValue && typeof leftValue === 'object' && !Array.isArray(leftValue) ? leftValue : {};
  const normalizedRight = rightValue && typeof rightValue === 'object' && !Array.isArray(rightValue) ? rightValue : {};
  return {
    ...normalizedLeft,
    ...normalizedRight,
  };
}

function mergeConfigObjects(base, override) {
  const left = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const right = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  return {
    ...left,
    ...right,
    firebase: mergeNamedObjectField(left, right, 'firebase'),
    localfs: mergeNamedObjectField(left, right, 'localfs'),
    refsTemplates: mergeNamedObjectField(left, right, 'refsTemplates'),
    aiWorkspaceTemplates: mergeNamedObjectField(left, right, 'aiWorkspaceTemplates'),
    uiTemplates: mergeNamedObjectField(left, right, 'uiTemplates'),
    sampleTemplateCatalog: mergeNamedObjectField(left, right, 'sampleTemplateCatalog'),
  };
}

function loadComposedConfig(configPath) {
  const config = readJsonFile(configPath);
  const configDir = path.dirname(configPath);
  const sharedConfigPath = path.resolve(configDir, SHARED_TEMPLATES_CONFIG_NAME);
  if (path.normalize(configPath) === path.normalize(sharedConfigPath) || !fs.existsSync(sharedConfigPath)) {
    return config;
  }
  return mergeConfigObjects(readJsonFile(sharedConfigPath), config);
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

function resolveMcpServerUrl(config) {
  const envOverride = typeof process.env.DEMO_BOARDS_MCP_SERVER_URL === 'string'
    ? process.env.DEMO_BOARDS_MCP_SERVER_URL.trim()
    : '';
  if (envOverride) return envOverride;
  return requireNonEmptyString(config?.mcpServerUrl, 'config.mcpServerUrl');
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

export function buildBoardConfig(boardId, source, { configDir, boardRoot = deriveBoardRoot(configDir), refsTemplates, aiWorkspaceTemplates, uiTemplates = {} }) {
  const normalizedBoardId = requireNonEmptyString(boardId, 'board id');
  const record = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const tokens = {
    boardId: normalizedBoardId,
    configDir,
    boardRoot,
    BOARD_ROOT: boardRoot,
  };

  const refsTemplateName = typeof record.refsTemplate === 'string' ? record.refsTemplate.trim() : '';
  let refsSource;
  if (refsTemplateName) {
    if (record.refs) {
      throw new Error(`Board '${normalizedBoardId}' must declare either refs or refsTemplate, not both`);
    }
    const template = refsTemplates[refsTemplateName];
    if (!template) {
      throw new Error(`Board '${normalizedBoardId}' references unknown refsTemplate '${refsTemplateName}'`);
    }
    refsSource = template;
  } else {
    refsSource = record.refs;
  }

  const aiWorkspaceTemplateName = typeof record.aiWorkspaceTemplate === 'string' && record.aiWorkspaceTemplate.trim()
    ? record.aiWorkspaceTemplate.trim()
    : '';
  let aiWorkspaceRoot = '';
  let scratchStore = '';
  if (aiWorkspaceTemplateName) {
    const template = aiWorkspaceTemplates[aiWorkspaceTemplateName];
    if (!template) {
      throw new Error(`Board '${normalizedBoardId}' references unknown aiWorkspaceTemplate '${aiWorkspaceTemplateName}'`);
    }
    const paths = template.paths && typeof template.paths === 'object' && !Array.isArray(template.paths)
      ? template.paths
      : {};
    if (typeof paths.aiWorkspaceRoot === 'string' && paths.aiWorkspaceRoot.trim()) {
      aiWorkspaceRoot = replaceTemplateTokens(paths.aiWorkspaceRoot.trim(), tokens);
    }
    if (typeof paths.scratchStore === 'string' && paths.scratchStore.trim()) {
      scratchStore = replaceTemplateTokens(paths.scratchStore.trim(), tokens);
    }
  }

  const uiTemplateName = typeof record.uiTemplate === 'string' && record.uiTemplate.trim()
    ? record.uiTemplate.trim()
    : '';
  let ui = {};
  if (uiTemplateName) {
    const template = uiTemplates[uiTemplateName];
    if (!template) {
      throw new Error(`Board '${normalizedBoardId}' references unknown uiTemplate '${uiTemplateName}'`);
    }
    ui = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  }

  return {
    id: normalizedBoardId,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : normalizedBoardId,
    ai: typeof record.ai === 'string' && record.ai.trim() ? record.ai.trim() : '',
    aiWorkspaceTemplate: aiWorkspaceTemplateName,
    aiWorkspaceRoot,
    scratchStore,
    uiTemplate: uiTemplateName,
    ui,
    refs: resolveBoardRefs(normalizedBoardId, refsSource, tokens),
    chat: record.chat && typeof record.chat === 'object' && !Array.isArray(record.chat)
      ? record.chat
      : {},
    queueWakeup: record.queueWakeup && typeof record.queueWakeup === 'object' && !Array.isArray(record.queueWakeup)
      ? record.queueWakeup
      : {},
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {},
  };
}

function collectBootstrapSampleBoards(config) {
  const source = config?.['bootstrap-sample-boards'];
  if (!source) return {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Config bootstrap-sample-boards must be an object');
  }
  const out = {};
  for (const [boardId, record] of Object.entries(source)) {
    const id = requireNonEmptyString(boardId, 'bootstrap-sample-board id');
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`bootstrap-sample-boards.${id} must be an object`);
    }
    out[id] = record;
  }
  return out;
}

function resolveRuntimeBoardsRegistry(config, tokens = {}, storageAdapter = 'firebase') {
  const source = config?.runtimeBoardsRegistry;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Config requires runtimeBoardsRegistry with a '${storageAdapter}' or 'default' entry`);
  }
  const scopedSource = source[storageAdapter] || source.default;
  if (!scopedSource || typeof scopedSource !== 'object' || Array.isArray(scopedSource)) {
    throw new Error(`Config runtimeBoardsRegistry must contain a '${storageAdapter}' or 'default' object entry`);
  }
  const boardsIndexRef = tryParseKindValueRef(scopedSource['boards-index']);
  if (!boardsIndexRef) {
    throw new Error(`Config runtimeBoardsRegistry.${storageAdapter}.boards-index must be a {kind, value} ref`);
  }
  const deprecatedContainerSource = Object.prototype.hasOwnProperty.call(scopedSource, 'deprecatedContainer')
    ? scopedSource.deprecatedContainer
    : null;
  if (deprecatedContainerSource !== null && deprecatedContainerSource !== undefined && !tryParseKindValueRef(deprecatedContainerSource)) {
    throw new Error(`Config runtimeBoardsRegistry.${storageAdapter}.deprecatedContainer must be null or a {kind, value} ref`);
  }
  const deprecatedContainerRef = tryParseKindValueRef(deprecatedContainerSource);
  return {
    boardsIndexRef: {
      kind: boardsIndexRef.kind,
      value: replaceTemplateTokens(boardsIndexRef.value, tokens),
    },
    deprecatedContainerRef: deprecatedContainerRef
      ? {
          kind: deprecatedContainerRef.kind,
          value: replaceTemplateTokens(deprecatedContainerRef.value, tokens),
        }
      : null,
  };
}

function resolveConfiguredHostPath(configDir, rawValue, tokens = {}) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }
  return resolveConfigRelativePath(configDir, replaceTemplateTokens(rawValue.trim(), tokens));
}

function resolveSampleTemplateCatalogConfig(config, configDir, tokens = {}) {
  const source = config?.sampleTemplateCatalog && typeof config.sampleTemplateCatalog === 'object' && !Array.isArray(config.sampleTemplateCatalog)
    ? config.sampleTemplateCatalog
    : {};
  const dir = resolveConfiguredHostPath(configDir, source.dir, tokens) || path.resolve(configDir, 'sample-card-templates');
  const rawIndexFile = typeof source.indexFile === 'string' ? source.indexFile.trim() : '';
  const indexFile = rawIndexFile
    ? (path.isAbsolute(replaceTemplateTokens(rawIndexFile, tokens))
        ? path.normalize(replaceTemplateTokens(rawIndexFile, tokens))
        : path.resolve(dir, replaceTemplateTokens(rawIndexFile, tokens)))
    : path.resolve(dir, '_index.json');
  return {
    dir,
    indexFile,
  };
}

export function loadFirebaseHostConfig(defaultConfigPath, cliArgs = process.argv.slice(2), processName = '') {
  const configPath = parseCliConfigPath(defaultConfigPath, cliArgs);
  const rawConfig = loadComposedConfig(configPath);
  const config = resolveProcessConfig(rawConfig, processName);
  const configDir = path.dirname(configPath);
  const boardRoot = deriveBoardRoot(configDir);
  const storageAdapter = typeof config.storageAdapter === 'string' && config.storageAdapter.trim()
    ? config.storageAdapter.trim().toLowerCase()
    : 'firebase';
  const hostTokens = {
    configDir,
    boardRoot,
    BOARD_ROOT: boardRoot,
  };
  const refsTemplates = config.refsTemplates && typeof config.refsTemplates === 'object' && !Array.isArray(config.refsTemplates)
    ? config.refsTemplates
    : {};
  const aiWorkspaceTemplates = config.aiWorkspaceTemplates && typeof config.aiWorkspaceTemplates === 'object' && !Array.isArray(config.aiWorkspaceTemplates)
    ? config.aiWorkspaceTemplates
    : {};
  const uiTemplates = config.uiTemplates && typeof config.uiTemplates === 'object' && !Array.isArray(config.uiTemplates)
    ? config.uiTemplates
    : {};
  const bootstrapSampleBoards = collectBootstrapSampleBoards(config);
  const runtimeBoardsRegistry = resolveRuntimeBoardsRegistry(config, hostTokens, storageAdapter);
  const sampleTemplateCatalog = resolveSampleTemplateCatalogConfig(config, configDir, hostTokens);

  return {
    configPath,
    configDir,
    boardRoot,
    storageAdapter,
    host: typeof config.host === 'string' && config.host.trim() ? config.host.trim() : '127.0.0.1',
    port: Number.isFinite(Number(config.port)) ? Number(config.port) : 7810,
    mcpServerUrl: resolveMcpServerUrl(config),
    serverOrigin: typeof config.serverOrigin === 'string' && config.serverOrigin.trim()
      ? config.serverOrigin.trim().replace(/\/$/, '')
      : '',
    apiBasePrefix: typeof config.apiBasePrefix === 'string' && config.apiBasePrefix.trim()
      ? config.apiBasePrefix.trim().replace(/\/$/, '')
      : '/api/boards',
    chatFlowTimeoutMs: Number.isFinite(Number(config.chatFlowTimeoutMs)) ? Number(config.chatFlowTimeoutMs) : undefined,
    chatInvokeRefTimeoutMs: Number.isFinite(Number(config.chatInvokeRefTimeoutMs)) ? Number(config.chatInvokeRefTimeoutMs) : undefined,
    chatCopilotTimeoutMs: Number.isFinite(Number(config.chatCopilotTimeoutMs)) ? Number(config.chatCopilotTimeoutMs) : undefined,
    enableAssistantDebug: config.enableAssistantDebug === true,
    debugAssistantFile: typeof config.debugAssistantFile === 'string' ? config.debugAssistantFile.trim() : '',
    foundryAgents: config.foundryAgents && typeof config.foundryAgents === 'object' && !Array.isArray(config.foundryAgents)
      ? config.foundryAgents
      : {},
    aiWorkspaceTemplates,
    refsTemplates,
    uiTemplates,
    firebase: config.firebase && typeof config.firebase === 'object' && !Array.isArray(config.firebase)
      ? config.firebase
      : {},
    bootstrapSampleBoards,
    runtimeBoardsRegistry,
    boardsIndexRef: runtimeBoardsRegistry.boardsIndexRef,
    deprecatedContainerRef: runtimeBoardsRegistry.deprecatedContainerRef,
    sampleTemplateCatalog,
  };
}

export function resolveConfigRelativePath(configDir, relativeOrAbsolutePath) {
  const normalized = requireNonEmptyString(relativeOrAbsolutePath, 'relative path');
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(configDir, normalized);
}
