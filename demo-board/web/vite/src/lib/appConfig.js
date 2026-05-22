const DEFAULT_REFRESH_ALL_INTERVAL_SECONDS = 5 * 60;
const DEFAULT_PAGE_SUBTITLE = 'Live operational intelligence for agent workflows';
const APP_CONFIG_OVERRIDE_STORAGE_KEY = 'demo-boards.app-config.override';
const APP_CONFIG_OVERRIDE_VERSION = 1;

export const FALLBACK_APP_CONFIG = Object.freeze({
  defaultBoardId: 'live',
  defaultBoard: {
    id: 'live',
    label: 'Live',
    subtitle: DEFAULT_PAGE_SUBTITLE,
  },
  pageTitle: 'Live',
  pageSubtitle: DEFAULT_PAGE_SUBTITLE,
  refreshAllIntervalSeconds: DEFAULT_REFRESH_ALL_INTERVAL_SECONDS,
  serverOrigin: 'http://localhost:7799',
});

function normalizeServerOrigin(serverOrigin) {
  if (typeof serverOrigin === 'string' && serverOrigin.trim()) {
    return serverOrigin.trim().replace(/\/+$/, '');
  }

  return FALLBACK_APP_CONFIG.serverOrigin;
}

function normalizeAppConfig(config) {
  const defaultBoardId = typeof config?.defaultBoardId === 'string' && config.defaultBoardId.trim()
    ? config.defaultBoardId.trim()
    : FALLBACK_APP_CONFIG.defaultBoardId;
  const defaultBoardConfig = config?.defaultBoard && typeof config.defaultBoard === 'object'
    ? config.defaultBoard
    : {};
  const defaultBoardLabel = typeof defaultBoardConfig?.label === 'string' && defaultBoardConfig.label.trim()
    ? defaultBoardConfig.label.trim()
    : defaultBoardId;
  const defaultBoardSubtitle = typeof defaultBoardConfig?.subtitle === 'string' && defaultBoardConfig.subtitle.trim()
    ? defaultBoardConfig.subtitle.trim()
    : DEFAULT_PAGE_SUBTITLE;
  const refreshAllIntervalSeconds = Number(config?.refreshAllIntervalSeconds);
  const legacyRefreshAllIntervalMs = Number(config?.refreshAllIntervalMs);
  const resolvedRefreshAllIntervalSeconds = Number.isFinite(refreshAllIntervalSeconds) && refreshAllIntervalSeconds > 0
    ? refreshAllIntervalSeconds
    : (Number.isFinite(legacyRefreshAllIntervalMs) && legacyRefreshAllIntervalMs > 0
      ? legacyRefreshAllIntervalMs / 1000
      : DEFAULT_REFRESH_ALL_INTERVAL_SECONDS);

  return {
    defaultBoardId,
    defaultBoard: {
      id: defaultBoardId,
      label: defaultBoardLabel,
      subtitle: defaultBoardSubtitle,
    },
    pageTitle: defaultBoardLabel,
    pageSubtitle: defaultBoardSubtitle,
    refreshAllIntervalSeconds: resolvedRefreshAllIntervalSeconds,
    serverOrigin: normalizeServerOrigin(config?.serverOrigin),
  };
}

function mergeAppConfig(baseConfig, overrideConfig = {}) {
  const baseBoard = baseConfig?.defaultBoard && typeof baseConfig.defaultBoard === 'object'
    ? baseConfig.defaultBoard
    : {};
  const overrideBoard = overrideConfig?.defaultBoard && typeof overrideConfig.defaultBoard === 'object'
    ? overrideConfig.defaultBoard
    : {};

  return {
    ...baseConfig,
    ...overrideConfig,
    defaultBoard: {
      ...baseBoard,
      ...overrideBoard,
    },
  };
}

function getAppConfigSignature(config) {
  return JSON.stringify(normalizeAppConfig(config));
}

function getStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredOverrideEnvelope() {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(APP_CONFIG_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.version !== APP_CONFIG_OVERRIDE_VERSION
      || typeof parsed.baseSignature !== 'string'
      || !parsed.config
      || typeof parsed.config !== 'object'
    ) {
      storage.removeItem(APP_CONFIG_OVERRIDE_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    storage.removeItem(APP_CONFIG_OVERRIDE_STORAGE_KEY);
    return null;
  }
}

function writeStoredOverrideEnvelope(envelope) {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(APP_CONFIG_OVERRIDE_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

let currentAppConfig = normalizeAppConfig(FALLBACK_APP_CONFIG);
let currentBaseAppConfig = currentAppConfig;
let currentAppConfigHasOverride = false;

export let DEFAULT_BOARD_ID = currentAppConfig.defaultBoardId;
export let DEFAULT_BOARD = currentAppConfig.defaultBoard;
export let DEFAULT_BOARD_LABEL = currentAppConfig.defaultBoard.label;
export let PAGE_TITLE = currentAppConfig.pageTitle;
export let PAGE_SUBTITLE = currentAppConfig.pageSubtitle;
export let REFRESH_ALL_INTERVAL_SECONDS = currentAppConfig.refreshAllIntervalSeconds;
export let SERVER = currentAppConfig.serverOrigin;

function applyAppConfig(config) {
  currentAppConfig = normalizeAppConfig(config);
  DEFAULT_BOARD_ID = currentAppConfig.defaultBoardId;
  DEFAULT_BOARD = currentAppConfig.defaultBoard;
  DEFAULT_BOARD_LABEL = currentAppConfig.defaultBoard.label;
  PAGE_TITLE = currentAppConfig.pageTitle;
  PAGE_SUBTITLE = currentAppConfig.pageSubtitle;
  REFRESH_ALL_INTERVAL_SECONDS = currentAppConfig.refreshAllIntervalSeconds;
  SERVER = currentAppConfig.serverOrigin;
  return currentAppConfig;
}

export async function loadAppConfig() {
  const configUrl = `${import.meta.env.BASE_URL}app-config.json`;
  let baseConfig = FALLBACK_APP_CONFIG;

  try {
    const response = await fetch(configUrl, { cache: 'no-store' });
    if (response.ok) {
      baseConfig = await response.json();
    }
  } catch {
    // Fall back to embedded defaults when the hosted config is unavailable.
  }

  currentBaseAppConfig = normalizeAppConfig(baseConfig);
  currentAppConfigHasOverride = false;

  const storedOverride = readStoredOverrideEnvelope();
  if (storedOverride) {
    if (storedOverride.baseSignature === getAppConfigSignature(currentBaseAppConfig)) {
      currentAppConfigHasOverride = true;
      return applyAppConfig(storedOverride.config);
    }

    clearStoredAppConfigOverride();
  }

  return applyAppConfig(currentBaseAppConfig);
}

export function getAppConfig() {
  return currentAppConfig;
}

export function getBaseAppConfig() {
  return currentBaseAppConfig;
}

export function hasStoredAppConfigOverride() {
  return currentAppConfigHasOverride;
}

export function saveAppConfigOverride(overrideConfig) {
  const baseConfig = currentBaseAppConfig || normalizeAppConfig(FALLBACK_APP_CONFIG);
  const mergedConfig = normalizeAppConfig(mergeAppConfig(baseConfig, overrideConfig));
  const saved = writeStoredOverrideEnvelope({
    version: APP_CONFIG_OVERRIDE_VERSION,
    baseSignature: getAppConfigSignature(baseConfig),
    config: mergedConfig,
  });

  if (saved) {
    currentAppConfigHasOverride = true;
  }

  return mergedConfig;
}

export function clearStoredAppConfigOverride() {
  const storage = getStorage();
  currentAppConfigHasOverride = false;
  if (!storage) return;
  try {
    storage.removeItem(APP_CONFIG_OVERRIDE_STORAGE_KEY);
  } catch {
    // ignore storage failures and continue with the in-memory config.
  }
}