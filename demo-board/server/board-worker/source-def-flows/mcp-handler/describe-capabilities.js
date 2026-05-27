import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveManifestPath(mcpServerDir, manifestRef) {
  if (!manifestRef || typeof manifestRef !== 'string') {
    return null;
  }
  if (path.isAbsolute(manifestRef)) {
    return manifestRef;
  }
  if (manifestRef.startsWith('.') || manifestRef.includes('/') || manifestRef.includes('\\')) {
    return path.resolve(mcpServerDir, manifestRef);
  }
  return path.resolve(mcpServerDir, 'manifests', manifestRef);
}

function summarizeTool(tool) {
  const summary = {
    name: tool.name,
  };
  if (typeof tool.title === 'string' && tool.title) {
    summary.title = tool.title;
  }
  if (typeof tool.description === 'string' && tool.description) {
    summary.description = tool.description;
  }
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    summary.inputSchema = tool.inputSchema;
  }
  return summary;
}

function summarizeServer(entry, manifest) {
  const summary = {};

  if (manifest?.server && typeof manifest.server === 'object') {
    if (typeof manifest.server.name === 'string' && manifest.server.name) {
      summary.name = manifest.server.name;
    }
    if (typeof manifest.server.title === 'string' && manifest.server.title) {
      summary.title = manifest.server.title;
    }
    if (typeof manifest.server.description === 'string' && manifest.server.description) {
      summary.description = manifest.server.description;
    }
  }

  const connection = manifest?.connection && typeof manifest.connection === 'object'
    ? manifest.connection
    : entry?.connection && typeof entry.connection === 'object'
      ? entry.connection
      : null;
  if (connection && typeof connection.transport === 'string' && connection.transport) {
    summary.transport = connection.transport;
  }

  return summary;
}

export async function describeCapabilities(context = {}) {
  try {
    const projectRoot = context?.projectRoot || process.cwd();
    const mcpServerDir = path.resolve(projectRoot, '..', 'mcp-server');
    const registryPath = path.resolve(mcpServerDir, 'registry.json');

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const servers = registry?.servers && typeof registry.servers === 'object' ? registry.servers : {};
    const manifestLoaderPath = path.resolve(mcpServerDir, 'src', 'manifest-loader.js');
    const { loadManifest } = await import(pathToFileURL(manifestLoaderPath).href);

    const serverEntries = {};
    const allTools = [];

    for (const [serverName, entry] of Object.entries(servers)) {
      const manifestRef = entry?.manifest;
      const serverPayload = {};

      try {
        const manifestPath = resolveManifestPath(mcpServerDir, manifestRef);
        if (!manifestPath) {
          throw new Error('Registry entry is missing manifest');
        }
        const loaded = loadManifest(manifestPath);
        const tools = loaded.manifest.tools.map(summarizeTool);
        const serverSummary = summarizeServer(entry, loaded.manifest);
        if (Object.keys(serverSummary).length > 0) {
          serverPayload.server = serverSummary;
        }
        serverPayload.tools = tools;
        serverPayload.toolCount = tools.length;
        allTools.push(...tools.map((tool) => ({ ...tool, server: serverName })));
      } catch {
        serverPayload.error = 'Capabilities unavailable';
      }

      serverEntries[serverName] = serverPayload;
    }

    return {
      serverCount: Object.keys(serverEntries).length,
      servers: serverEntries,
      allTools,
    };
  } catch {
    throw new Error('Capabilities unavailable');
  }
}