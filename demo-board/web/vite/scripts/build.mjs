#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viteRoot = resolve(here, '..');
const repoRoot = resolve(viteRoot, '..', '..', '..');
const docsDir = resolve(repoRoot, 'docs');
const serverConfigPath = resolve(viteRoot, '..', '..', 'server-config.json');
const FALLBACK_CONFIG = {
  port: 7799,
  refreshAllIntervalMs: 5 * 60 * 1000,
  defaultBoard: 'live',
  title: 'Live',
  subtitle: 'Live operational intelligence for agent workflows',
  boards: {
    live: {
      label: 'Live',
      subtitle: 'Live operational intelligence for agent workflows',
    },
  },
};

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (result.status !== 0) {
    console.error(`\n[build] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

async function readServerConfig() {
  try {
    await access(serverConfigPath);
    const imported = await import(`${pathToFileURL(serverConfigPath).href}?t=${Date.now()}`, { with: { type: 'json' } });
    return imported.default ?? FALLBACK_CONFIG;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return FALLBACK_CONFIG;
    }
    throw error;
  }
}

function pickDefaultBoard(config) {
  if (typeof config?.defaultBoard === 'string' && config.defaultBoard.trim()) {
    return config.defaultBoard.trim();
  }

  const boardIds = config?.boards && typeof config.boards === 'object'
    ? Object.keys(config.boards)
    : [];
  return boardIds[0] || 'live';
}

function toRuntimeConfig(serverConfig) {
  const defaultBoardId = process.env.VITE_APP_DEFAULT_BOARD || pickDefaultBoard(serverConfig);
  const defaultBoard = serverConfig?.boards?.[defaultBoardId] ?? {};
  const pageSubtitle = process.env.VITE_APP_PAGE_SUBTITLE
    || (typeof defaultBoard?.subtitle === 'string' && defaultBoard.subtitle.trim()
      ? defaultBoard.subtitle.trim()
      : (typeof serverConfig?.subtitle === 'string' && serverConfig.subtitle.trim()
        ? serverConfig.subtitle.trim()
        : FALLBACK_CONFIG.subtitle));
  const pageTitle = process.env.VITE_APP_PAGE_TITLE
    || (typeof serverConfig?.title === 'string' && serverConfig.title.trim()
      ? serverConfig.title.trim()
      : (typeof defaultBoard?.label === 'string' && defaultBoard.label.trim()
        ? defaultBoard.label.trim()
        : FALLBACK_CONFIG.title));
  const serverPort = Number(serverConfig?.port);
  const refreshAllIntervalMs = Number(serverConfig?.refreshAllIntervalMs);

  return {
    defaultBoardId,
    defaultBoard: {
      id: defaultBoardId,
      label: process.env.VITE_APP_DEFAULT_BOARD_LABEL || (typeof defaultBoard?.label === 'string' && defaultBoard.label.trim() ? defaultBoard.label.trim() : defaultBoardId),
      subtitle: process.env.VITE_APP_DEFAULT_BOARD_SUBTITLE || pageSubtitle,
    },
    pageTitle,
    pageSubtitle,
    refreshAllIntervalMs: Number.isFinite(refreshAllIntervalMs) && refreshAllIntervalMs > 0
      ? refreshAllIntervalMs
      : FALLBACK_CONFIG.refreshAllIntervalMs,
    serverOrigin: process.env.VITE_SERVER_ORIGIN || `http://localhost:${Number.isFinite(serverPort) && serverPort > 0 ? serverPort : FALLBACK_CONFIG.port}`,
  };
}

const serverConfig = await readServerConfig();
const runtimeConfig = toRuntimeConfig(serverConfig);
const env = {
  ...process.env,
  VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/demo-boards/',
};

run(process.execPath, [resolve(viteRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: viteRoot, env });
await writeFile(resolve(docsDir, 'app-config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`);
await writeFile(resolve(docsDir, '.nojekyll'), '');