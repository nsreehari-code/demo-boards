#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

function interpolateValue(value, context) {
  if (typeof value === 'string') {
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
    return new StreamableHTTPClientTransport(new URL(connection.url));
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

  const interpolationContext = {
    ...(sourceDef._projections || {}),
    ...((cfg.args && typeof cfg.args === 'object') ? cfg.args : {}),
  };

  try {
    let manifestConnection = null;
    if (cfg.manifest) {
      const manifestPath = resolveManifestPath(executorDir, cfg.manifest);
      const { loadManifest } = await importManifestLoader(executorDir);
      const loaded = loadManifest(manifestPath);
      manifestConnection = loaded.manifest.connection || null;
      const toolExists = loaded.manifest.tools.some((tool) => tool.name === cfg.tool);
      if (!toolExists) {
        throw new Error(`MCP tool not found in manifest: ${cfg.tool}`);
      }
    }

    const connection = resolveConnection(manifestConnection, cfg.server);
    const toolArguments = interpolateValue(cfg.input && typeof cfg.input === 'object' ? cfg.input : {}, interpolationContext);

    const { Client } = await importClientModules();
    const client = new Client(
      { name: 'demo-task-executor', version: '1.0.0' },
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
