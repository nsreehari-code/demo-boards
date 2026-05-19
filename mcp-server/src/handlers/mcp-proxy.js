import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest-loader.js';
import { runAzureCli } from './azure-cli.js';

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

function resolveConnection(connection) {
  const resolved = {
    ...(connection || {}),
  };

  if (!resolved.transport) {
    throw new Error('Manifest connection.transport is required for mcp.proxy');
  }

  if (resolved.urlEnvVar && !resolved.url && process.env[resolved.urlEnvVar]) {
    resolved.url = process.env[resolved.urlEnvVar];
  }
  if (!resolved.url && resolved.urlDefault) {
    resolved.url = resolved.urlDefault;
  }

  return resolved;
}

function resolveAuthConfig(connection) {
  const auth = connection?.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return null;
  }
  return auth;
}

function runAzureCliLogin(auth) {
  const tenantFromEnv = typeof auth?.tenantEnvVar === 'string' && auth.tenantEnvVar
    ? process.env[auth.tenantEnvVar]
    : '';
  const tenant = typeof auth?.tenant === 'string' && auth.tenant.trim()
    ? auth.tenant.trim()
    : (tenantFromEnv || '').trim();

  const args = ['login'];
  if (tenant) {
    args.push('--tenant', tenant);
  }

  runAzureCli(args, { inherit: true });
}

function mintAzureCliBearerToken(auth) {
  const resource = typeof auth?.resource === 'string' && auth.resource.trim()
    ? auth.resource.trim()
    : '';
  if (!resource) {
    throw new Error('azure-cli-bearer auth requires a non-empty resource');
  }

  const tenantFromEnv = typeof auth?.tenantEnvVar === 'string' && auth.tenantEnvVar
    ? process.env[auth.tenantEnvVar]
    : '';
  const tenant = typeof auth?.tenant === 'string' && auth.tenant.trim()
    ? auth.tenant.trim()
    : (tenantFromEnv || '').trim();

  const args = ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv'];
  if (tenant) {
    args.push('--tenant', tenant);
  }

  let raw = '';
  try {
    raw = runAzureCli(args).trim();
  } catch (err) {
    if (auth?.loginOnDemand === false) {
      throw err;
    }
    runAzureCliLogin(auth);
    raw = runAzureCli(args).trim();
  }

  if (!raw) {
    throw new Error('Azure CLI returned an empty access token');
  }
  return raw;
}

function buildAuthHeaders(connection) {
  const auth = resolveAuthConfig(connection);
  if (!auth) return undefined;

  if (auth.type === 'azure-cli-bearer') {
    const token = mintAzureCliBearerToken(auth);
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  throw new Error(`Unsupported mcp.proxy auth type: ${String(auth.type || 'unknown')}`);
}

function toRequestInit(connection) {
  const baseHeaders = connection?.headers && typeof connection.headers === 'object' && !Array.isArray(connection.headers)
    ? connection.headers
    : undefined;
  const authHeaders = buildAuthHeaders(connection);
  const headers = {
    ...(baseHeaders || {}),
    ...(authHeaders || {}),
  };

  if (Object.keys(headers).length === 0) {
    return undefined;
  }

  return { headers };
}

async function createTransport(connection) {
  const { StdioClientTransport, StreamableHTTPClientTransport } = await importClientModules();

  if (connection.transport === 'stdio' || connection.transport === 'local') {
    if (!connection.command || typeof connection.command !== 'string') {
      throw new Error('Manifest connection.command is required for stdio/local mcp.proxy transport');
    }
    return new StdioClientTransport({
      command: connection.command,
      args: Array.isArray(connection.args) ? connection.args : [],
      cwd: connection.cwd ? path.resolve(connection.cwd) : process.cwd(),
      env: connection.env && typeof connection.env === 'object' ? connection.env : undefined,
    });
  }

  if (connection.transport === 'streamable-http' || connection.transport === 'http') {
    if (!connection.url || typeof connection.url !== 'string') {
      throw new Error('Manifest connection.url is required for streamable-http/http mcp.proxy transport');
    }
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: toRequestInit(connection),
    });
  }

  throw new Error(`Unsupported mcp.proxy transport: ${connection.transport}`);
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
    Object.prototype.hasOwnProperty.call(structured, 'result')
  ) {
    return structured.result;
  }

  if (firstText && (!structured || (typeof structured === 'object' && Object.keys(structured).length === 0))) {
    return firstText.text;
  }

  return structured ?? content ?? response;
}

function resolveRemoteCall(args, tool) {
  const config = tool?.config && typeof tool.config === 'object' ? tool.config : {};
  const remoteToolField = typeof config.remoteToolFromArg === 'string' && config.remoteToolFromArg
    ? config.remoteToolFromArg
    : 'tool';
  const remoteArgsField = typeof config.remoteArgumentsFromArg === 'string' && config.remoteArgumentsFromArg
    ? config.remoteArgumentsFromArg
    : 'arguments';

  const remoteTool = typeof config.remoteTool === 'string' && config.remoteTool
    ? config.remoteTool
    : (typeof args?.[remoteToolField] === 'string' && args[remoteToolField].trim() ? args[remoteToolField].trim() : tool.name);

  const remoteArguments = config.remoteTool
    ? (args && typeof args === 'object' ? args : {})
    : (args?.[remoteArgsField] && typeof args[remoteArgsField] === 'object' ? args[remoteArgsField] : {});

  if (!remoteTool) {
    throw new Error('Unable to resolve remote MCP tool name');
  }

  return {
    remoteTool,
    remoteArguments,
  };
}

export async function handleRemoteMcpTool(args, tool) {
  const manifestPath = tool?.manifestPath;
  if (!manifestPath || typeof manifestPath !== 'string') {
    throw new Error('mcp.proxy tool is missing manifestPath');
  }

  const loaded = loadManifest(manifestPath);
  const connection = resolveConnection(loaded.manifest.connection || null);
  const remoteTool = loaded.manifest.tools.find((entry) => entry.name === tool.name);
  if (!remoteTool) {
    throw new Error(`Remote MCP tool not found in manifest: ${tool.name}`);
  }
  const remoteCall = resolveRemoteCall(args, remoteTool);

  const { Client } = await importClientModules();
  const client = new Client(
    { name: 'demo-boards-mcp-proxy', version: '0.1.0' },
    { capabilities: {} },
  );
  const transport = await createTransport(connection);

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: remoteCall.remoteTool,
      arguments: remoteCall.remoteArguments,
    });
    const result = normalizeToolResult(response);
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: {
        result,
      },
    };
  } finally {
    if (typeof transport.close === 'function') {
      await transport.close();
    }
  }
}