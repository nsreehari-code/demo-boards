import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:7801/mcp';
const DEFAULT_SETUP_LEAVES = {
  boardRuntime: 'runtime',
  boardOutputsStore: 'board-outputs',
  cardStore: 'cards-store',
  artifactsStore: 'cards-files',
  chatStore: 'cards-chats',
  scratchStore: 'scratch',
  archivalStore: 'runtime-archive',
};
const DEFAULT_WATCHPARTY_FILES_DIR = 'watchparty-files-for-chat';

function requireNonEmptyText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[workspace-setup] Missing required config: ${label}`);
  }
  return value.trim();
}

function ensureDirectoryExists(dirPath, label) {
  const normalized = requireNonEmptyText(dirPath, label);
  fs.mkdirSync(normalized, { recursive: true });
  return normalized;
}

function listFilesInDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function listFilesRecursive(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const output = [];
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        output.push(entryPath);
      }
    }
  };
  walk(dirPath);
  return output;
}

function syncFlatFilesIntoDir(targetDir, sourceDirs) {
  fs.mkdirSync(targetDir, { recursive: true });

  const expectedFiles = new Set();
  for (const sourceDir of sourceDirs) {
    if (!sourceDir || !fs.existsSync(sourceDir)) continue;
    for (const fileName of fs.readdirSync(sourceDir)) {
      const sourcePath = path.join(sourceDir, fileName);
      if (!fs.statSync(sourcePath).isFile()) continue;
      expectedFiles.add(fileName);
    }
  }

  for (const fileName of fs.readdirSync(targetDir)) {
    const targetPath = path.join(targetDir, fileName);
    if (fs.statSync(targetPath).isFile() && !expectedFiles.has(fileName)) {
      fs.rmSync(targetPath, { force: true });
    }
  }

  for (const sourceDir of sourceDirs) {
    if (!sourceDir || !fs.existsSync(sourceDir)) continue;
    for (const fileName of fs.readdirSync(sourceDir)) {
      const sourcePath = path.join(sourceDir, fileName);
      if (!fs.statSync(sourcePath).isFile()) continue;
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
  }
}

function syncRecursiveFilesIntoDir(targetDir, sourceDirs) {
  fs.mkdirSync(targetDir, { recursive: true });

  const expectedFiles = new Set();
  for (const sourceDir of sourceDirs) {
    if (!sourceDir || !fs.existsSync(sourceDir)) continue;
    for (const filePath of listFilesRecursive(sourceDir)) {
      expectedFiles.add(path.relative(sourceDir, filePath));
    }
  }

  for (const targetPath of listFilesRecursive(targetDir)) {
    const relativePath = path.relative(targetDir, targetPath);
    if (!expectedFiles.has(relativePath)) {
      fs.rmSync(targetPath, { force: true });
    }
  }

  for (const sourceDir of sourceDirs) {
    if (!sourceDir || !fs.existsSync(sourceDir)) continue;
    for (const filePath of listFilesRecursive(sourceDir)) {
      const relativePath = path.relative(sourceDir, filePath);
      const targetPath = path.join(targetDir, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(filePath, targetPath);
    }
  }
}

function resolveSetupPaths(boardId, boardConfig) {
  const setup = boardConfig?.setup && typeof boardConfig.setup === 'object' && !Array.isArray(boardConfig.setup)
    ? boardConfig.setup
    : {};
  const setupRoot = path.resolve(requireNonEmptyText(setup.setupRoot, `boards.${boardId}.setup.setupRoot`));
  const aiWorkspaceLeaf = requireNonEmptyText(
    setup.aiWorkspaceRoot ?? DEFAULT_SETUP_LEAVES.aiWorkspaceRoot ?? 'copilot-workspaces',
    `boards.${boardId}.setup.aiWorkspaceRoot`,
  );
  const scratchLeaf = requireNonEmptyText(
    setup.scratchStore ?? DEFAULT_SETUP_LEAVES.scratchStore,
    `boards.${boardId}.setup.scratchStore`,
  );
  return {
    setupRoot,
    aiWorkspaceRoot: path.isAbsolute(aiWorkspaceLeaf) ? aiWorkspaceLeaf : path.resolve(setupRoot, aiWorkspaceLeaf),
    scratchDir: path.isAbsolute(scratchLeaf) ? scratchLeaf : path.resolve(setupRoot, scratchLeaf),
  };
}

function resolveWatchpartyDir(hostConfig, boardConfig, setupRoot) {
  const watchparty = hostConfig?.watchparty && typeof hostConfig.watchparty === 'object' && !Array.isArray(hostConfig.watchparty)
    ? hostConfig.watchparty
    : {};
  const configuredDir = typeof watchparty.filesForChatDir === 'string' && watchparty.filesForChatDir.trim()
    ? watchparty.filesForChatDir.trim()
    : DEFAULT_WATCHPARTY_FILES_DIR;
  return path.resolve(setupRoot, configuredDir);
}

function resolveLiveboardsMcpServerUrl(hostConfig) {
  const envOverride = typeof process.env.DEMO_BOARDS_MCP_SERVER_URL === 'string'
    ? process.env.DEMO_BOARDS_MCP_SERVER_URL.trim()
    : '';
  const configuredUrl = typeof hostConfig?.mcpServerUrl === 'string'
    ? hostConfig.mcpServerUrl.trim()
    : '';
  return envOverride || configuredUrl || DEFAULT_MCP_SERVER_URL;
}

function logMessage(log, message) {
  if (typeof log === 'function') {
    log(message);
  }
}

function resolveConfigPath(configDir, configValue) {
  if (typeof configValue !== 'string' || !configValue.trim()) return null;
  const trimmed = configValue.trim();
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(configDir, trimmed);
}

function writeWorkspaceConfig(configTarget, payload) {
  fs.writeFileSync(configTarget, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function deriveCopilotWorkspaceSetupEntries(boardId, boardConfig) {
  const explicitSetup = Array.isArray(boardConfig?.['copilot-workdirs-setup'])
    ? boardConfig['copilot-workdirs-setup'].filter((entry) => entry && typeof entry === 'object')
    : [];
  const customWorkspaceStems = Array.isArray(boardConfig?.chat?.copilot?.['custom-workspace-stems'])
    ? boardConfig.chat.copilot['custom-workspace-stems']
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean)
    : [];
  if (customWorkspaceStems.length === 0) {
    return explicitSetup;
  }

  const stems = ['default', ...customWorkspaceStems.filter((stem) => stem !== 'default')];
  return stems.map((stem) => ({
    'copilot-root': stem,
    instructionsDirs: ['../../server/chat-flow/instructions', `../../boards/${boardId}/copilot/${stem}/instructions`],
    agentsDirs: ['../../server/chat-flow/copilot-chat/agents', `../../boards/${boardId}/copilot/${stem}/agents`],
    agentsSkills: ['../../server/chat-flow/skills', `../../boards/${boardId}/copilot/${stem}/skills`],
    agentsHooks: ['../../server/chat-flow/copilot-chat/hooks', `../../boards/${boardId}/copilot/${stem}/hooks`],
    copyScripts: ['../../scripts/cli'],
  }));
}

export function prepareCopilotWorkspaceForBoard({
  boardId,
  boardConfig,
  configDir,
  hostConfig = {},
  cardsDir = '',
  log = console.log,
}) {
  const { setupRoot, aiWorkspaceRoot, scratchDir } = resolveSetupPaths(boardId, boardConfig);
  const watchPartyFilesForChatDir = resolveWatchpartyDir(hostConfig, boardConfig, setupRoot);
  const mcpServerUrl = resolveLiveboardsMcpServerUrl(hostConfig);

  ensureDirectoryExists(setupRoot, `boards.${boardId}.setup.setupRoot`);
  ensureDirectoryExists(aiWorkspaceRoot, `boards.${boardId}.setup.aiWorkspaceRoot`);
  ensureDirectoryExists(scratchDir, `boards.${boardId}.setup.scratchStore`);
  ensureDirectoryExists(watchPartyFilesForChatDir, `boards.${boardId}.watchparty.filesForChatDir`);

  const workspaceSetup = deriveCopilotWorkspaceSetupEntries(boardId, boardConfig);

  if (workspaceSetup.length === 0) {
    if (!cardsDir) return;
    const srcDir = path.dirname(cardsDir);
    const agentInstructionFiles = ['agent-instructions.md', 'agent-instructions-cardlayout.md'];
    const parts = [];
    for (const fileName of agentInstructionFiles) {
      const filePath = path.join(srcDir, fileName);
      if (fs.existsSync(filePath)) {
        parts.push(fs.readFileSync(filePath, 'utf-8').trimEnd());
      }
    }
    if (parts.length === 0) return;
    const githubRoot = path.join(setupRoot, '.github');
    fs.mkdirSync(githubRoot, { recursive: true });
    fs.writeFileSync(path.join(githubRoot, 'copilot-instructions.md'), `${parts.join('\n\n')}\n`, 'utf-8');
    fs.rmSync(path.join(setupRoot, 'copilot-instructions.md'), { force: true });
    return;
  }

  for (const entry of workspaceSetup) {
    const copilotRoot = typeof entry['copilot-root'] === 'string' ? entry['copilot-root'].trim() : '';
    if (!copilotRoot) continue;

    const workspaceRoot = path.join(aiWorkspaceRoot, copilotRoot);
    const githubRoot = path.join(workspaceRoot, '.github');
    const instructionsTarget = path.join(githubRoot, 'copilot-instructions.md');
    const legacyInstructionsTarget = path.join(workspaceRoot, 'copilot-instructions.md');
    const agentsTarget = path.join(githubRoot, 'agents');
    const hooksTarget = path.join(githubRoot, 'hooks');
    const skillsTarget = path.join(githubRoot, 'skills');
    const scriptsTarget = path.join(githubRoot, 'scripts');
    const configTarget = path.join(workspaceRoot, 'config.json');

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(githubRoot, { recursive: true });
    fs.mkdirSync(agentsTarget, { recursive: true });
    fs.mkdirSync(hooksTarget, { recursive: true });
    fs.mkdirSync(skillsTarget, { recursive: true });
    fs.mkdirSync(scriptsTarget, { recursive: true });

    const logCopiedFiles = (label, dirPath, copiedCount) => {
      logMessage(log, `[workspace-setup] board=${boardId} copilot=${copilotRoot} ${label}: ${dirPath || '(missing)'} (${copiedCount} files copied)`);
    };

    const instructionDirs = Array.isArray(entry.instructionsDirs) ? entry.instructionsDirs : [];
    const instructionParts = [];
    for (const dir of instructionDirs) {
      const resolvedDir = resolveConfigPath(configDir, dir);
      if (!resolvedDir || !fs.existsSync(resolvedDir)) {
        logCopiedFiles('instructionsDirs', resolvedDir, 0);
        continue;
      }
      const files = listFilesInDir(resolvedDir);
      for (const filePath of files) {
        instructionParts.push(fs.readFileSync(filePath, 'utf-8').trimEnd());
      }
      logCopiedFiles('instructionsDirs', resolvedDir, files.length);
    }

    if (instructionParts.length > 0) {
      fs.writeFileSync(instructionsTarget, `${instructionParts.join('\n===============\n')}\n`, 'utf-8');
      fs.rmSync(legacyInstructionsTarget, { force: true });
    } else {
      fs.rmSync(instructionsTarget, { force: true });
      fs.rmSync(legacyInstructionsTarget, { force: true });
    }

    const agentsDirs = Array.isArray(entry.agentsDirs) ? entry.agentsDirs : [];
    const resolvedAgentsDirs = agentsDirs.map((dir) => resolveConfigPath(configDir, dir)).filter(Boolean);
    syncFlatFilesIntoDir(agentsTarget, resolvedAgentsDirs);
    for (const dir of agentsDirs) {
      const resolvedDir = resolveConfigPath(configDir, dir);
      logCopiedFiles('agentsDirs', resolvedDir, resolvedDir && fs.existsSync(resolvedDir) ? listFilesRecursive(resolvedDir).length : 0);
    }

    const agentsHooks = Array.isArray(entry.agentsHooks) ? entry.agentsHooks : [];
    const resolvedAgentsHooks = agentsHooks.map((dir) => resolveConfigPath(configDir, dir)).filter(Boolean);
    syncFlatFilesIntoDir(hooksTarget, resolvedAgentsHooks);
    for (const dir of agentsHooks) {
      const resolvedDir = resolveConfigPath(configDir, dir);
      logCopiedFiles('agentsHooks', resolvedDir, resolvedDir && fs.existsSync(resolvedDir) ? listFilesRecursive(resolvedDir).length : 0);
    }

    const agentsSkills = Array.isArray(entry.agentsSkills) ? entry.agentsSkills : [];
    const resolvedAgentsSkills = agentsSkills.map((dir) => resolveConfigPath(configDir, dir)).filter(Boolean);
    syncRecursiveFilesIntoDir(skillsTarget, resolvedAgentsSkills);
    for (const dir of agentsSkills) {
      const resolvedDir = resolveConfigPath(configDir, dir);
      logCopiedFiles('agentsSkills', resolvedDir, resolvedDir && fs.existsSync(resolvedDir) ? listFilesRecursive(resolvedDir).length : 0);
    }

    const copyScriptDirs = Array.isArray(entry.copyScripts)
      ? entry.copyScripts.map((dir) => resolveConfigPath(configDir, dir)).filter(Boolean)
      : [];
    syncFlatFilesIntoDir(scriptsTarget, copyScriptDirs);
    writeWorkspaceConfig(configTarget, {
      board_id: boardId,
      mcp_server_url: mcpServerUrl,
      scratch_dir: scratchDir,
      watchparty_dir: watchPartyFilesForChatDir,
    });
    logMessage(log, `[workspace-setup] board=${boardId} copilot=${copilotRoot} copyScripts: ${copyScriptDirs.length > 0 ? copyScriptDirs.join(', ') : '(none)'}`);
    for (const scriptsDir of copyScriptDirs) {
      const copiedCount = scriptsDir && fs.existsSync(scriptsDir)
        ? fs.readdirSync(scriptsDir).filter((fileName) => fs.statSync(path.join(scriptsDir, fileName)).isFile()).length
        : 0;
      logCopiedFiles('copyScripts', scriptsDir, copiedCount);
    }
  }
}

export function prepareFoundryWorkspaceForBoard({
  boardId,
  boardConfig,
  hostConfig = {},
  log = console.log,
}) {
  const { setupRoot, aiWorkspaceRoot, scratchDir } = resolveSetupPaths(boardId, boardConfig);
  const watchPartyFilesForChatDir = resolveWatchpartyDir(hostConfig, boardConfig, setupRoot);
  const foundryRoot = path.join(aiWorkspaceRoot, 'foundry');
  const mcpServerUrl = resolveLiveboardsMcpServerUrl(hostConfig);

  ensureDirectoryExists(setupRoot, `boards.${boardId}.setup.setupRoot`);
  ensureDirectoryExists(aiWorkspaceRoot, `boards.${boardId}.setup.aiWorkspaceRoot`);
  ensureDirectoryExists(scratchDir, `boards.${boardId}.setup.scratchStore`);
  ensureDirectoryExists(watchPartyFilesForChatDir, `boards.${boardId}.watchparty.filesForChatDir`);
  ensureDirectoryExists(foundryRoot, `boards.${boardId}.foundry.workspaceRoot`);

  writeWorkspaceConfig(path.join(foundryRoot, 'config.json'), {
    board_id: boardId,
    mcp_server_url: mcpServerUrl,
    scratch_dir: scratchDir,
    watchparty_dir: watchPartyFilesForChatDir,
    foundry_endpoint: typeof hostConfig?.foundryAgents?.endpoint === 'string' ? hostConfig.foundryAgents.endpoint : '',
    foundry_chat_agent_id: typeof hostConfig?.foundryAgents?.chatAgentId === 'string' ? hostConfig.foundryAgents.chatAgentId : '',
  });
  logMessage(log, `[workspace-setup] board=${boardId} foundry workspace ready at ${foundryRoot}`);
}
