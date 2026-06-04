#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFirebaseHostConfig } from '../firebase-adapter/load-config.js';
import { prepareCopilotWorkspaceForBoard } from '../../workspace-setup/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const defaultConfigPath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');
const hostConfig = loadFirebaseHostConfig(defaultConfigPath, process.argv.slice(2), 'workspace-setup-copilot');

for (const [boardId, boardConfig] of Object.entries(hostConfig.boards || {})) {
  const hasExplicitSetup = Array.isArray(boardConfig?.['copilot-workdirs-setup']) && boardConfig['copilot-workdirs-setup'].length > 0;
  const hasCustomStems = Array.isArray(boardConfig?.chat?.copilot?.['custom-workspace-stems'])
    && boardConfig.chat.copilot['custom-workspace-stems'].length > 0;
  if (!hasExplicitSetup && !hasCustomStems) {
    continue;
  }
  prepareCopilotWorkspaceForBoard({
    boardId,
    boardConfig,
    configDir: hostConfig.configDir,
    hostConfig,
  });
}
