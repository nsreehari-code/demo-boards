#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARD_ROOT = path.resolve(SERVER_DIR, '..');
const REPO_ROOT = path.resolve(BOARD_ROOT, '..');
const MCP_SERVER_ROOT = path.join(REPO_ROOT, 'mcp-server');
const DEFAULT_REGISTRY_PATH = path.join(MCP_SERVER_ROOT, 'registry.json');
const DEFAULT_COPILOT_CONFIG_PATH = path.join(os.homedir(), '.copilot', 'mcp-config.json');
const DEFAULT_AGENTFACE_MANIFEST_PATH = path.join(
  SERVER_DIR,
  'hosted-board-runtime',
  'http-mcp-controlface',
  'agentface.tools.json',
);
const DEFAULT_AGENTFACE_NAME = 'liveboards';

function parseArgs(argv) {
  const args = {
    dryRun: false,
    refresh: false,
    registryPath: DEFAULT_REGISTRY_PATH,
    configPath: DEFAULT_COPILOT_CONFIG_PATH,
    agentfaceUrl: '',
    agentfaceManifest: DEFAULT_AGENTFACE_MANIFEST_PATH,
    agentfaceName: DEFAULT_AGENTFACE_NAME,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (value === '--refresh') {
      args.refresh = true;
      continue;
    }
    if (value === '--registry' && argv[i + 1]) {
      args.registryPath = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (value === '--config' && argv[i + 1]) {
      args.configPath = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (value === '--agentface-url' && argv[i + 1]) {
      args.agentfaceUrl = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (value === '--agentface-manifest' && argv[i + 1]) {
      args.agentfaceManifest = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (value === '--agentface-name' && argv[i + 1]) {
      args.agentfaceName = String(argv[i + 1]).trim();
      i += 1;
    }
  }

  return args;
}

function buildAgentfaceEntry(manifestPath, url) {
  const manifest = readJsonFile(manifestPath);
  const tools = Array.isArray(manifest?.tools)
    ? manifest.tools.map((tool) => tool?.name).filter((toolName) => typeof toolName === 'string' && toolName)
    : [];
  if (tools.length === 0) {
    throw new Error(`Agentface manifest ${manifestPath} does not declare any tools`);
  }
  return {
    type: 'http',
    url,
    tools,
  };
}

function readJsonFile(filePath, { missingOk = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (missingOk) return null;
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse JSON at ${filePath}: ${String(err?.message || err)}`);
  }
}

function resolveManifestPath(manifestRef) {
  if (!manifestRef || typeof manifestRef !== 'string') {
    throw new Error('Registry entry manifest must be a non-empty string');
  }
  if (path.isAbsolute(manifestRef)) return manifestRef;
  if (manifestRef.startsWith('.') || manifestRef.includes('/') || manifestRef.includes('\\')) {
    return path.resolve(MCP_SERVER_ROOT, manifestRef);
  }
  return path.resolve(MCP_SERVER_ROOT, 'manifests', manifestRef);
}

function resolveUrl(connection) {
  if (!connection || typeof connection !== 'object') return null;
  if (typeof connection.url === 'string' && connection.url.trim()) return connection.url.trim();
  if (typeof connection.urlEnvVar === 'string' && process.env[connection.urlEnvVar]) {
    return String(process.env[connection.urlEnvVar]).trim();
  }
  if (typeof connection.urlDefault === 'string' && connection.urlDefault.trim()) {
    return connection.urlDefault.trim();
  }
  return null;
}

function normalizeHeaders(connection) {
  const headers = connection?.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  return headers;
}

function normalizeEnv(connection) {
  const env = connection?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  return env;
}

function normalizeCwd(connection, manifestPath) {
  const cwd = connection?.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  if (path.isAbsolute(cwd)) return cwd;
  return path.resolve(path.dirname(manifestPath), cwd);
}

function mergeConnection(manifestConnection, overrideConnection) {
  return {
    ...(manifestConnection || {}),
    ...(overrideConnection || {}),
  };
}

function toCopilotServerConfig(serverName, manifestPath, manifest, overrideConnection) {
  const connection = mergeConnection(manifest?.connection, overrideConnection);
  if (!connection || typeof connection !== 'object') {
    throw new Error(`Manifest ${manifestPath} is missing connection details`);
  }

  const tools = Array.isArray(manifest?.tools)
    ? manifest.tools.map((tool) => tool?.name).filter((toolName) => typeof toolName === 'string' && toolName)
    : [];

  if (tools.length === 0) {
    throw new Error(`Manifest ${manifestPath} does not declare any tools`);
  }

  if (connection.transport === 'streamable-http' || connection.transport === 'http') {
    const url = resolveUrl(connection);
    if (!url) {
      throw new Error(`Manifest ${manifestPath} does not resolve an HTTP MCP URL`);
    }
    const headers = normalizeHeaders(connection);
    return {
      type: 'http',
      url,
      ...(headers ? { headers } : {}),
      tools,
    };
  }

  if (connection.transport === 'sse') {
    const url = resolveUrl(connection);
    if (!url) {
      throw new Error(`Manifest ${manifestPath} does not resolve an SSE MCP URL`);
    }
    const headers = normalizeHeaders(connection);
    return {
      type: 'sse',
      url,
      ...(headers ? { headers } : {}),
      tools,
    };
  }

  if (connection.transport === 'stdio' || connection.transport === 'local') {
    if (typeof connection.command !== 'string' || !connection.command.trim()) {
      throw new Error(`Manifest ${manifestPath} is missing command for stdio MCP transport`);
    }
    const env = normalizeEnv(connection);
    const cwd = normalizeCwd(connection, manifestPath);
    return {
      type: 'local',
      command: connection.command,
      args: Array.isArray(connection.args) ? connection.args : [],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      tools,
    };
  }

  throw new Error(`Unsupported MCP transport in ${manifestPath}: ${String(connection.transport || 'unknown')}`);
}

function buildMissingEntries(registry) {
  const servers = registry?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Registry must define an object at servers');
  }

  const entries = {};
  for (const [serverName, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Registry server ${serverName} must be an object`);
    }
    const manifestPath = resolveManifestPath(entry.manifest);
    if (!fs.existsSync(manifestPath)) {
      console.warn(`[sync-copilot-mcp-config] Skipping ${serverName}: manifest not found at ${manifestPath}`);
      continue;
    }
    const manifest = readJsonFile(manifestPath);
    entries[serverName] = toCopilotServerConfig(serverName, manifestPath, manifest, entry.connection);
  }
  return entries;
}

function mergeMissingEntries(existingConfig, newEntries) {
  const base = existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
    ? existingConfig
    : {};
  const existingServers = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? { ...base.mcpServers }
    : {};

  const added = [];
  const skipped = [];
  for (const [serverName, serverConfig] of Object.entries(newEntries)) {
    if (Object.prototype.hasOwnProperty.call(existingServers, serverName)) {
      skipped.push(serverName);
      continue;
    }
    existingServers[serverName] = serverConfig;
    added.push(serverName);
  }

  return {
    mergedConfig: {
      ...base,
      mcpServers: existingServers,
    },
    added,
    skipped,
  };
}

function refreshEntries(existingConfig, newEntries) {
  const base = existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
    ? existingConfig
    : {};
  const existingServers = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? { ...base.mcpServers }
    : {};

  const added = [];
  const updated = [];
  for (const [serverName, serverConfig] of Object.entries(newEntries)) {
    if (Object.prototype.hasOwnProperty.call(existingServers, serverName)) {
      updated.push(serverName);
    } else {
      added.push(serverName);
    }
    existingServers[serverName] = serverConfig;
  }

  return {
    mergedConfig: {
      ...base,
      mcpServers: existingServers,
    },
    added,
    updated,
    skipped: [],
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJsonFile(args.registryPath);
  const translatedEntries = buildMissingEntries(registry);
  if (args.agentfaceUrl) {
    translatedEntries[args.agentfaceName] = buildAgentfaceEntry(args.agentfaceManifest, args.agentfaceUrl);
  }
  const existingConfig = readJsonFile(args.configPath, { missingOk: true });
  const { mergedConfig, added, updated, skipped } = args.refresh
    ? refreshEntries(existingConfig, translatedEntries)
    : mergeMissingEntries(existingConfig, translatedEntries);

  const summary = {
    registryPath: args.registryPath,
    configPath: args.configPath,
    dryRun: args.dryRun,
    refresh: args.refresh,
    added,
    ...(Array.isArray(updated) ? { updated } : {}),
    skipped,
  };

  if (!args.dryRun && added.length > 0) {
    ensureParentDir(args.configPath);
    fs.writeFileSync(args.configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
  }

  if (!args.dryRun && Array.isArray(updated) && updated.length > 0) {
    ensureParentDir(args.configPath);
    fs.writeFileSync(args.configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
  }

  if (!args.dryRun && added.length === 0 && !fs.existsSync(args.configPath)) {
    ensureParentDir(args.configPath);
    fs.writeFileSync(args.configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (err) {
  console.error(`[sync-copilot-mcp-config] ${String(err?.message || err)}`);
  process.exit(1);
}