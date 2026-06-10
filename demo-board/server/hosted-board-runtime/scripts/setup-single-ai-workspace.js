#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveBoardRootFromModuleUrl } from '../../shared/board-root.js';
import { loadFirebaseHostConfig } from '../firebase-adapter/load-config.js';
import { createDynamicBoards } from '../boards-index/dynamic-boards.js';
import { initializeLocalFsServices } from '../localfs-adapter/localfs-init.js';
import { initializeFirebaseServices } from '../firebase-adapter/firebase-init.js';

const TAG = 'setup-single-ai-workspace';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const BOARD_ROOT = deriveBoardRootFromModuleUrl(import.meta.url, '../..');
const defaultConfigPath = path.join(runtimeRoot, 'hosted-board-runtime.localfs.config.json');

const rawArgs = process.argv.slice(2);
const boardIdArg = rawArgs.find((arg) => !arg.startsWith('--'));
if (!boardIdArg) {
  console.error(`[${TAG}] Usage: setup-single-ai-workspace.js <board-id> [--config <path>]`);
  process.exit(1);
}
const cliArgs = rawArgs.filter((arg) => arg !== boardIdArg);

const hostConfig = loadFirebaseHostConfig(defaultConfigPath, cliArgs, TAG);
const configuredBoardRoot = typeof hostConfig.boardRoot === 'string' && hostConfig.boardRoot.trim()
  ? path.normalize(hostConfig.boardRoot)
  : BOARD_ROOT;
const adapterServices = hostConfig.storageAdapter === 'localfs'
  ? await initializeLocalFsServices(hostConfig.localfs)
  : await initializeFirebaseServices(hostConfig.firebase);
const dynamicBoards = createDynamicBoards({ hostConfig, adapterServices });
const boardConfig = await dynamicBoards.get(boardIdArg);
if (!boardConfig) {
  console.error(`[${TAG}] Board "${boardIdArg}" not found in boards-index for ${hostConfig.configPath || defaultConfigPath}`);
  process.exit(1);
}

const ai = (boardConfig.ai || '').trim().toLowerCase();
if (ai !== 'copilot' && ai !== 'foundry') {
  console.error(`[${TAG}] boards.${boardIdArg}.ai must be "copilot" or "foundry" (got "${boardConfig.ai || ''}")`);
  process.exit(1);
}

const aiWorkspaceRootRaw = typeof boardConfig.aiWorkspaceRoot === 'string' ? boardConfig.aiWorkspaceRoot.trim() : '';
if (!aiWorkspaceRootRaw) {
  console.error(`[${TAG}] aiWorkspaceTemplates.${boardConfig.aiWorkspaceTemplate || '?'}.paths.aiWorkspaceRoot is required (board ${boardIdArg})`);
  process.exit(1);
}
if (!path.isAbsolute(aiWorkspaceRootRaw)) {
  console.error(`[${TAG}] boards.${boardIdArg}.aiWorkspaceRoot must be an absolute path (got '${aiWorkspaceRootRaw}')`);
  process.exit(1);
}
const aiWorkspaceRoot = path.normalize(aiWorkspaceRootRaw);

const scratchStoreRaw = typeof boardConfig.scratchStore === 'string' ? boardConfig.scratchStore.trim() : '';
if (!scratchStoreRaw) {
  console.error(`[${TAG}] aiWorkspaceTemplates.${boardConfig.aiWorkspaceTemplate || '?'}.paths.scratchStore is required (board ${boardIdArg})`);
  process.exit(1);
}
if (!path.isAbsolute(scratchStoreRaw)) {
  console.error(`[${TAG}] boards.${boardIdArg}.scratchStore must be an absolute path (got '${scratchStoreRaw}')`);
  process.exit(1);
}
const scratchDir = path.normalize(scratchStoreRaw);

const watchpartyDir = path.join(configuredBoardRoot, 'logs', 'watch-party', boardIdArg);

const mcpServerUrl = hostConfig.mcpServerUrl;
const controlfaceHost = (hostConfig.controlface?.host || '127.0.0.1').toString().trim() || '127.0.0.1';
const controlfacePort = hostConfig.controlface?.port || 7799;
const agentFacePathRaw = (hostConfig.agentFaceMcp || '/agent/mcp').toString().trim() || '/agent/mcp';
const agentFacePath = agentFacePathRaw.startsWith('/') ? agentFacePathRaw : `/${agentFacePathRaw}`;
const agentFaceMcpUrl = `http://${controlfaceHost}:${controlfacePort}${agentFacePath}`;

function resolveDir(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const resolved = substituteTemplateTokens(rel);
  return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(configuredBoardRoot, resolved);
}

function listFilesShallow(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name));
}

function listFilesRecursive(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function copyShallow(sourceDirs, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const src of sourceDirs) {
    for (const filePath of listFilesShallow(src)) {
      fs.copyFileSync(filePath, path.join(targetDir, path.basename(filePath)));
      copied += 1;
    }
  }
  return copied;
}

function copyRecursive(sourceDirs, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const src of sourceDirs) {
    for (const filePath of listFilesRecursive(src)) {
      const dest = path.join(targetDir, path.relative(src, filePath));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(filePath, dest);
      copied += 1;
    }
  }
  return copied;
}

function substituteTemplateTokens(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\{\{\s*boardId\s*\}\}/g, boardIdArg)
    .replace(/\{\{\s*BOARD_ROOT\s*\}\}/g, configuredBoardRoot)
    .replace(/\{\{\s*boardRoot\s*\}\}/g, configuredBoardRoot)
    .replace(/\{\{\s*AGENT_FACE_MCP_URL\s*\}\}/g, agentFaceMcpUrl)
    .replace(/\{\{\s*MCP_SERVER_URL\s*\}\}/g, mcpServerUrl || '');
}

function setupCopilot() {
  const explicitTemplate = (boardConfig.aiWorkspaceTemplate || '').trim();
  if (!explicitTemplate) {
    console.error(`[${TAG}] boards.${boardIdArg}.aiWorkspaceTemplate is required for ai=copilot`);
    process.exit(1);
  }
  const template = hostConfig.aiWorkspaceTemplates?.[explicitTemplate];
  if (!template || typeof template !== 'object') {
    console.error(`[${TAG}] aiWorkspaceTemplates.${explicitTemplate} not found`);
    process.exit(1);
  }
  const rawEntries = Array.isArray(template['ai-workdirs-setup'])
    ? template['ai-workdirs-setup'].filter((entry) => entry && typeof entry === 'object')
    : [];
  if (rawEntries.length === 0) {
    console.error(`[${TAG}] aiWorkspaceTemplates.${explicitTemplate}.ai-workdirs-setup is empty`);
    process.exit(1);
  }
  const entries = rawEntries.map((entry) => ({
    'copilot-root': substituteTemplateTokens(entry['copilot-root']),
    instructionsDirs: (entry.instructionsDirs || []).map(substituteTemplateTokens),
    agentsDirs: (entry.agentsDirs || []).map(substituteTemplateTokens),
    agentsHooks: (entry.agentsHooks || []).map(substituteTemplateTokens),
    agentsSkills: (entry.agentsSkills || []).map(substituteTemplateTokens),
    copyScripts: (entry.copyScripts || []).map(substituteTemplateTokens),
  }));

  for (const entry of entries) {
    const stem = (entry['copilot-root'] || '').trim();
    if (!stem) continue;
    const workspaceRoot = path.join(aiWorkspaceRoot, stem);
    const githubRoot = path.join(workspaceRoot, '.github');
    fs.mkdirSync(githubRoot, { recursive: true });

    const instructionDirs = (entry.instructionsDirs || []).map(resolveDir).filter(Boolean);
    const parts = [];
    for (const dir of instructionDirs) {
      for (const filePath of listFilesShallow(dir)) {
        parts.push(fs.readFileSync(filePath, 'utf-8').trimEnd());
      }
    }
    const instructionsTarget = path.join(githubRoot, 'copilot-instructions.md');
    if (parts.length > 0) {
      fs.writeFileSync(instructionsTarget, `${parts.join('\n===============\n')}\n`, 'utf-8');
    }

    const agentsCount = copyShallow((entry.agentsDirs || []).map(resolveDir).filter(Boolean), path.join(githubRoot, 'agents'));
    const hooksCount = copyShallow((entry.agentsHooks || []).map(resolveDir).filter(Boolean), path.join(githubRoot, 'hooks'));
    const skillsCount = copyRecursive((entry.agentsSkills || []).map(resolveDir).filter(Boolean), path.join(githubRoot, 'skills'));
    const scriptsCount = copyShallow((entry.copyScripts || []).map(resolveDir).filter(Boolean), path.join(githubRoot, 'scripts'));

    fs.writeFileSync(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      board_id: boardIdArg,
      mcp_server_url: mcpServerUrl,
      scratch_dir: scratchDir,
      watchparty_dir: watchpartyDir,
    }, null, 2)}\n`, 'utf8');

    console.log(`[${TAG}] ai=copilot board=${boardIdArg} stem=${stem} instructions=${parts.length} agents=${agentsCount} hooks=${hooksCount} skills=${skillsCount} scripts=${scriptsCount} -> ${workspaceRoot}`);
  }

  const setupScripts = Array.isArray(template.copilotSetupScripts)
    ? template.copilotSetupScripts.filter((spec) => spec && typeof spec === 'object' && typeof spec.script === 'string')
    : [];
  for (const spec of setupScripts) {
    const scriptPath = substituteTemplateTokens(spec.script);
    const resolvedScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(configuredBoardRoot, scriptPath);
    const scriptArgs = (Array.isArray(spec.args) ? spec.args : []).map(substituteTemplateTokens);
    try {
      execFileSync(process.execPath, [resolvedScript, ...scriptArgs], {
        cwd: path.dirname(resolvedScript),
        stdio: 'inherit',
      });
      console.log(`[${TAG}] ran copilotSetupScript ${path.basename(resolvedScript)} ${scriptArgs.join(' ')}`);
    } catch (err) {
      console.error(`[${TAG}] copilotSetupScript failed: ${resolvedScript} :: ${String(err?.message || err)}`);
      process.exit(1);
    }
  }
}

function setupFoundry() {
  const foundryRoot = path.join(aiWorkspaceRoot, 'foundry');
  const foundryEndpoint = (hostConfig.foundryAgents?.endpoint || '').trim();
  const foundryChatAgentId = (hostConfig.foundryAgents?.chatAgentId || '').trim();

  fs.mkdirSync(foundryRoot, { recursive: true });
  fs.writeFileSync(path.join(foundryRoot, 'config.json'), `${JSON.stringify({
    board_id: boardIdArg,
    mcp_server_url: mcpServerUrl,
    scratch_dir: scratchDir,
    watchparty_dir: watchpartyDir,
    foundry_endpoint: foundryEndpoint,
    foundry_chat_agent_id: foundryChatAgentId,
  }, null, 2)}\n`, 'utf8');

  console.log(`[${TAG}] ai=foundry board=${boardIdArg} -> ${foundryRoot}`);
}

if (ai === 'copilot') setupCopilot();
else setupFoundry();

fs.mkdirSync(aiWorkspaceRoot, { recursive: true });
fs.writeFileSync(path.join(aiWorkspaceRoot, '.host-marker'), `${new Date().toISOString()}\n`, 'utf8');
