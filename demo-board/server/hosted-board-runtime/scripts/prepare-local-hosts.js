#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFirebaseHostConfig } from '../firebase-adapter/load-config.js';
import { createDynamicBoards } from '../boards-index/dynamic-boards.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import { initializeFirebaseServices } from '../firebase-adapter/firebase-init.js';
import {
  boardNeedsAiWorkspaceSetup,
  runSetupSingleAiWorkspaceScript,
} from '../host-shared/ai-workspace-setup.js';

const TAG = 'prepare-local-hosts';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const defaultConfigPath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');
const setupSingleWorkspaceScriptPath = path.join(__dirname, 'setup-single-ai-workspace.js');

function ensureBoardsIndexContainer(hostConfig) {
  const boardsIndexRef = hostConfig?.boardsIndexRef;
  if (boardsIndexRef?.kind !== 'fs-path') {
    return;
  }
  const dir = typeof boardsIndexRef.value === 'string' ? boardsIndexRef.value.trim() : '';
  if (!dir) {
    return;
  }
  fs.mkdirSync(path.normalize(dir), { recursive: true });
}

async function main() {
  const hostConfig = loadFirebaseHostConfig(defaultConfigPath, process.argv.slice(2), TAG);
  ensureBoardsIndexContainer(hostConfig);
  const adapterServices = hostConfig.storageAdapter === 'localfs'
    ? await initializeLocalFsServices(hostConfig.localfs)
    : await initializeFirebaseServices(hostConfig.firebase);
  const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
  const boardConfigs = await dynamicBoards.list();
  const setupBoardIds = new Set(
    boardConfigs
      .filter((boardConfig) => boardNeedsAiWorkspaceSetup(boardConfig))
      .map((boardConfig) => boardConfig.id),
  );

  for (const boardId of setupBoardIds) {
    await runSetupSingleAiWorkspaceScript(setupSingleWorkspaceScriptPath, boardId, hostConfig.configPath);
  }

  console.log(`[${TAG}] boards=${boardConfigs.length} aiWorkspaceSetup=${setupBoardIds.size}`);
}

main().catch((error) => {
  console.error(`[${TAG}] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});