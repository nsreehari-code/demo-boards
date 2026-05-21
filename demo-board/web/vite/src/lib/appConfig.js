const DEFAULT_REFRESH_ALL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SUBTITLE = 'Live operational intelligence for agent workflows';

export const FALLBACK_APP_CONFIG = Object.freeze({
  defaultBoardId: 'live',
  defaultBoard: {
    id: 'live',
    label: 'Live',
    subtitle: DEFAULT_PAGE_SUBTITLE,
  },
  pageTitle: 'Live',
  pageSubtitle: DEFAULT_PAGE_SUBTITLE,
  refreshAllIntervalMs: DEFAULT_REFRESH_ALL_INTERVAL_MS,
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
  const refreshAllIntervalMs = Number(config?.refreshAllIntervalMs);

  return {
    defaultBoardId,
    defaultBoard: {
      id: defaultBoardId,
      label: defaultBoardLabel,
      subtitle: defaultBoardSubtitle,
    },
    pageTitle: typeof config?.pageTitle === 'string' && config.pageTitle.trim()
      ? config.pageTitle.trim()
      : defaultBoardLabel,
    pageSubtitle: typeof config?.pageSubtitle === 'string' && config.pageSubtitle.trim()
      ? config.pageSubtitle.trim()
      : defaultBoardSubtitle,
    refreshAllIntervalMs: Number.isFinite(refreshAllIntervalMs) && refreshAllIntervalMs > 0
      ? refreshAllIntervalMs
      : DEFAULT_REFRESH_ALL_INTERVAL_MS,
    serverOrigin: normalizeServerOrigin(config?.serverOrigin),
  };
}

let currentAppConfig = normalizeAppConfig(FALLBACK_APP_CONFIG);

export let DEFAULT_BOARD_ID = currentAppConfig.defaultBoardId;
export let DEFAULT_BOARD = currentAppConfig.defaultBoard;
export let DEFAULT_BOARD_LABEL = currentAppConfig.defaultBoard.label;
export let PAGE_TITLE = currentAppConfig.pageTitle;
export let PAGE_SUBTITLE = currentAppConfig.pageSubtitle;
export let REFRESH_ALL_INTERVAL_MS = currentAppConfig.refreshAllIntervalMs;
export let SERVER = currentAppConfig.serverOrigin;

function applyAppConfig(config) {
  currentAppConfig = normalizeAppConfig(config);
  DEFAULT_BOARD_ID = currentAppConfig.defaultBoardId;
  DEFAULT_BOARD = currentAppConfig.defaultBoard;
  DEFAULT_BOARD_LABEL = currentAppConfig.defaultBoard.label;
  PAGE_TITLE = currentAppConfig.pageTitle;
  PAGE_SUBTITLE = currentAppConfig.pageSubtitle;
  REFRESH_ALL_INTERVAL_MS = currentAppConfig.refreshAllIntervalMs;
  SERVER = currentAppConfig.serverOrigin;
  return currentAppConfig;
}

export async function loadAppConfig() {
  const configUrl = `${import.meta.env.BASE_URL}app-config.json`;
  try {
    const response = await fetch(configUrl, { cache: 'no-store' });
    if (response.ok) {
      return applyAppConfig(await response.json());
    }
  } catch {
    // Fall back to embedded defaults when the hosted config is unavailable.
  }

  return applyAppConfig(FALLBACK_APP_CONFIG);
}

export function getAppConfig() {
  return currentAppConfig;
}