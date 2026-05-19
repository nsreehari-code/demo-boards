import serverConfig from '../../../../server-config.json';

function resolveDefaultBoard(config) {
  if (typeof config?.defaultBoard === 'string' && config.defaultBoard.trim()) {
    return config.defaultBoard.trim();
  }

  const boardIds = config?.boards && typeof config.boards === 'object'
    ? Object.keys(config.boards)
    : [];
  return boardIds[0] || 'finbook';
}

function resolveServerOrigin(config) {
  const port = Number(config?.port);
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : 7799;
  const protocol = typeof window !== 'undefined' && window.location?.protocol
    ? window.location.protocol
    : 'http:';
  const hostname = typeof window !== 'undefined' && window.location?.hostname
    ? window.location.hostname
    : '127.0.0.1';

  return `${protocol}//${hostname}:${resolvedPort}`;
}

function resolveDefaultBoardConfig(config) {
  const boardId = resolveDefaultBoard(config);
  const board = config?.boards && typeof config.boards === 'object'
    ? config.boards[boardId]
    : null;
  return board && typeof board === 'object' ? board : null;
}

function resolvePageTitle(config) {
  if (typeof config?.title === 'string' && config.title.trim()) {
    return config.title.trim();
  }

  const defaultBoardConfig = resolveDefaultBoardConfig(config);
  if (typeof defaultBoardConfig?.label === 'string' && defaultBoardConfig.label.trim()) {
    return defaultBoardConfig.label.trim();
  }

  return 'Live Boards';
}

export const DEFAULT_BOARD_ID = resolveDefaultBoard(serverConfig);
export const DEFAULT_BOARD = resolveDefaultBoardConfig(serverConfig);
export const DEFAULT_BOARD_LABEL = typeof DEFAULT_BOARD?.label === 'string' && DEFAULT_BOARD.label.trim()
  ? DEFAULT_BOARD.label.trim()
  : DEFAULT_BOARD_ID;
export const PAGE_TITLE = resolvePageTitle(serverConfig);
export const SERVER = resolveServerOrigin(serverConfig);