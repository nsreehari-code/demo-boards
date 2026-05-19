#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

function interpolateValue(value, context) {
  if (typeof value === 'string') {
    const exactTokenMatch = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (exactTokenMatch) {
      const resolved = context?.[exactTokenMatch[1]];
      return resolved === undefined ? '' : resolved;
    }

    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
      const resolved = context?.[key];
      if (resolved === undefined) return '';
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateValue(entry, context));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, context)]),
    );
  }
  return value;
}

function resolveManifestPath(executorDir, manifestRef) {
  if (!manifestRef) return null;
  if (path.isAbsolute(manifestRef)) return manifestRef;

  if (manifestRef.startsWith('.') || manifestRef.includes('/') || manifestRef.includes('\\')) {
    return path.resolve(executorDir, manifestRef);
  }

  const siblingManifestPath = path.resolve(executorDir, '..', 'mcp-server', 'manifests', manifestRef);
  return siblingManifestPath;
}

async function importManifestLoader(executorDir) {
  const manifestLoaderPath = path.resolve(executorDir, '..', 'mcp-server', 'src', 'manifest-loader.js');
  return import(pathToFileURL(manifestLoaderPath).href);
}

async function importClientModules() {
  const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');
  const stdioModule = await import('@modelcontextprotocol/sdk/client/stdio.js');

  let streamableModule = null;
  try {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  } catch {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamable-http.js');
  }

  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
  };
}

function resolveConnection(defaultConnection, explicitConnection) {
  const merged = {
    ...(defaultConnection || {}),
    ...(explicitConnection || {}),
  };

  if (!merged.transport) {
    throw new Error('mcp.server.transport is required, or the selected manifest must provide connection.transport');
  }

  if (merged.urlEnvVar && !merged.url && process.env[merged.urlEnvVar]) {
    merged.url = process.env[merged.urlEnvVar];
  }
  if (!merged.url && merged.urlDefault) {
    merged.url = merged.urlDefault;
  }

  return merged;
}

async function createTransport(connection, extra) {
  const { StdioClientTransport, StreamableHTTPClientTransport } = await importClientModules();

  if (connection.transport === 'stdio') {
    if (!connection.command || typeof connection.command !== 'string') {
      throw new Error('mcp.server.command is required for stdio transport');
    }
    return new StdioClientTransport({
      command: connection.command,
      args: Array.isArray(connection.args) ? connection.args : [],
      cwd: connection.cwd
        ? path.resolve(extra?.boardSetupRoot || process.cwd(), connection.cwd)
        : (extra?.boardSetupRoot || process.cwd()),
      env: connection.env && typeof connection.env === 'object' ? connection.env : undefined,
    });
  }

  if (connection.transport === 'streamable-http') {
    if (!connection.url || typeof connection.url !== 'string') {
      throw new Error('mcp.server.url is required for streamable-http transport');
    }
    const requestInit = connection.headers && typeof connection.headers === 'object' && !Array.isArray(connection.headers)
      ? { headers: connection.headers }
      : undefined;
    return new StreamableHTTPClientTransport(new URL(connection.url), { requestInit });
  }

  throw new Error(`Unsupported MCP transport: ${connection.transport}`);
}

function normalizeToolResult(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const firstText = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  const structured = response?.structuredContent;

  if (
    structured &&
    typeof structured === 'object' &&
    !Array.isArray(structured) &&
    Object.keys(structured).length === 1 &&
    typeof structured.response === 'string'
  ) {
    return structured.response;
  }

  if (
    structured &&
    typeof structured === 'object' &&
    !Array.isArray(structured) &&
    Object.keys(structured).length === 1 &&
    Object.prototype.hasOwnProperty.call(structured, 'result')
  ) {
    return structured.result;
  }

  if (firstText && (!structured || (typeof structured === 'object' && Object.keys(structured).length === 0))) {
    return firstText.text;
  }

  return structured ?? content ?? response;
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const extra = context?.extra || {};
  const executorDir = context?.executorDir || process.cwd();
  const cfg = typeof sourceDef.mcp === 'object' ? sourceDef.mcp : null;

  if (!cfg) {
    return { result: 'failure', data: { error: 'mcp source definition is missing' }, error: 'missing mcp config' };
  }
  if (!cfg.tool || typeof cfg.tool !== 'string') {
    return { result: 'failure', data: { error: 'mcp.tool is required' }, error: 'missing tool' };
  }
  if (!cfg.server) {
    return { result: 'failure', data: { error: 'mcp.server is required (string registry name or inline connection object)' }, error: 'missing server' };
  }

  const interpolationContext = {
    ...(sourceDef._projections || {}),
    ...((cfg.args && typeof cfg.args === 'object') ? cfg.args : {}),
  };

  try {
    // Resolve server: string → look up in mcp-server/registry.json; object → use inline
    let resolvedManifestRef = null;
    let resolvedServerOverride = typeof cfg.server === 'object' ? cfg.server : null;

    if (typeof cfg.server === 'string') {
      const fs = await import('node:fs');
      const registryPath = path.resolve(executorDir, '..', 'mcp-server', 'registry.json');
      let registry;
      try {
        registry = JSON.parse(fs.default.readFileSync(registryPath, 'utf8'));
      } catch (err) {
        throw new Error(`Cannot read MCP server registry (${registryPath}): ${String(err?.message || err)}`);
      }
      const entry = registry?.servers?.[cfg.server];
      if (!entry) {
        throw new Error(`MCP server "${cfg.server}" not found in registry (${registryPath})`);
      }
      if (entry.manifest) resolvedManifestRef = entry.manifest;
      if (entry.connection) resolvedServerOverride = entry.connection;
    }

    let manifestConnection = null;
    if (resolvedManifestRef) {
      const mcpServerDir = path.resolve(executorDir, '..', 'mcp-server');
      const manifestPath = resolveManifestPath(mcpServerDir, resolvedManifestRef);
      const { loadManifest } = await importManifestLoader(executorDir);
      const loaded = loadManifest(manifestPath);
      manifestConnection = loaded.manifest.connection || null;
      const toolExists = loaded.manifest.tools.some((tool) => tool.name === cfg.tool);
      if (!toolExists) {
        throw new Error(`MCP tool not found in manifest: ${cfg.tool}`);
      }
    }

    const connection = resolveConnection(manifestConnection, resolvedServerOverride);
    const toolArguments = interpolateValue(cfg.input && typeof cfg.input === 'object' ? cfg.input : {}, interpolationContext);

    const { Client } = await importClientModules();
    const client = new Client(
      { name: 'board-worker', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = await createTransport(connection, extra);

    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: cfg.tool,
        arguments: toolArguments,
      });
      const resultValue = normalizeToolResult(response);
      return { result: 'success', data: { resultValue } };
    } finally {
      if (typeof transport.close === 'function') {
        await transport.close();
      }
    }
  } catch (err) {
    const msg = String(err?.message || err);
    return { result: 'failure', data: { error: `mcp invocation failed: ${msg}` }, error: msg };
  }
}
