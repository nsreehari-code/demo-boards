import fs from 'node:fs';
import path from 'node:path';

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ensureTools(tools, manifestPath) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`Manifest ${manifestPath} must declare a non-empty tools array`);
  }
  return tools.map((tool, index) => {
    ensureObject(tool, `tools[${index}] in ${manifestPath}`);
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error(`tools[${index}] in ${manifestPath} is missing string field: name`);
    }
    if (!tool.handler || typeof tool.handler !== 'string') {
      throw new Error(`tools[${index}] in ${manifestPath} is missing string field: handler`);
    }
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new Error(`tools[${index}] in ${manifestPath} is missing object field: inputSchema`);
    }
    return tool;
  });
}

export function loadManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const manifest = JSON.parse(raw);
  const server = ensureObject(manifest.server || {}, `server in ${absolutePath}`);
  const tools = ensureTools(manifest.tools, absolutePath);
  const connection = manifest.connection && typeof manifest.connection === 'object'
    ? manifest.connection
    : null;
  return {
    absolutePath,
    manifest: {
      server,
      connection,
      tools,
    },
  };
}

export function loadManifests(manifestPaths) {
  if (!Array.isArray(manifestPaths) || manifestPaths.length === 0) {
    throw new Error('At least one --manifest <path> is required');
  }

  const toolMap = new Map();
  const manifests = manifestPaths.map(loadManifest);

  for (const entry of manifests) {
    for (const tool of entry.manifest.tools) {
      if (toolMap.has(tool.name)) {
        throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      }
      toolMap.set(tool.name, { ...tool, manifestPath: entry.absolutePath });
    }
  }

  const primaryServer = manifests[0].manifest.server;
  return {
    server: {
      name: primaryServer.name || 'demo-boards-mcp',
      version: primaryServer.version || '0.1.0',
      description: primaryServer.description || '',
    },
    connection: manifests[0].manifest.connection || null,
    tools: Array.from(toolMap.values()),
    manifests,
  };
}
