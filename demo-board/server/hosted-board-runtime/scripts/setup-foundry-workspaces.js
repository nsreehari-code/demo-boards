#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFirebaseHostConfig } from '../firebase-adapter/load-config.js';
import { prepareFoundryWorkspaceForBoard } from '../../workspace-setup/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const defaultConfigPath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');
const hostConfig = loadFirebaseHostConfig(defaultConfigPath, process.argv.slice(2), 'workspace-setup-foundry');

for (const [boardId, boardConfig] of Object.entries(hostConfig.boards || {})) {
  if ((boardConfig?.chat?.assistant || '').trim().toLowerCase() !== 'foundry') {
    continue;
  }
  prepareFoundryWorkspaceForBoard({
    boardId,
    boardConfig,
    hostConfig,
  });
}
