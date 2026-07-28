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
  const resourceFromEnv = typeof auth?.resourceEnvVar === 'string' && auth.resourceEnvVar
    ? process.env[auth.resourceEnvVar]
    : '';
  const resource = (resourceFromEnv || '').trim()
    || (typeof auth?.resource === 'string' ? auth.resource.trim() : '');
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

export async function connectRemoteMcp(connectionConfig) {
  const connection = resolveConnection(connectionConfig);
  const { Client } = await importClientModules();
  const client = new Client(
    { name: 'demo-boards-mcp-proxy', version: '0.1.0' },
    { capabilities: {} },
  );
  const transport = await createTransport(connection);
  await client.connect(transport);

  return {
    client,
    async close() {
      await client.close();
    },
  };
}

export async function listRemoteMcpTools(connectionConfig) {
  const remote = await connectRemoteMcp(connectionConfig);
  try {
    const tools = [];
    let cursor;
    do {
      const page = await remote.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(Array.isArray(page?.tools) ? page.tools : []));
      cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return { tools };
  } finally {
    await remote.close();
  }
}

export async function callRemoteMcpTool(connectionConfig, name, args) {
  const remote = await connectRemoteMcp(connectionConfig);
  try {
    return await remote.client.callTool({
      name,
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    });
  } finally {
    await remote.close();
  }
}

// Many MCP tools (including Sentinel's query_lake) return structured JSON
// in content[].text rather than in structuredContent. We treat that text as
// canonical structured data: when it parses cleanly as JSON we surface the
// parsed value, otherwise the original string is preserved.
function parseTextAsJsonOrPassThrough(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"' && first !== '-' && (first < '0' || first > '9')
    && trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null') {
    return text;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
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
    return parseTextAsJsonOrPassThrough(firstText.text);
  }

  return structured ?? content ?? response;
}

function resolveRemoteCall(args, tool) {
  const config = tool?.config && typeof tool.config === 'object' ? tool.config : {};

  // The mcp.proxy handler supports three calling conventions:
  //
  //   1. Router envelope — manifest opts in by declaring
  //      config.remoteToolFromArg and/or config.remoteArgumentsFromArg.
  //      The local tool acts as a dispatcher: callers send
  //      { tool: "<remoteName>", arguments: { ... } } and the proxy
  //      forwards the inner arguments to the named upstream tool.
  //
  //   2. Pinned remote name — manifest sets config.remoteTool to a fixed
  //      upstream tool name. The caller-supplied args object is forwarded
  //      verbatim as the upstream arguments.
  //
  //   3. Transparent passthrough (default) — neither config key is set.
  //      The local tool name is reused as the upstream tool name and the
  //      caller-supplied args object is forwarded verbatim. This mirrors a
  //      1:1 re-export of the upstream tool.
  //
  // Previously the default branch always assumed convention #1, which
  // silently dropped the caller's arguments (and surfaced as upstream
  // schema errors like "Argument 'query' for property 'queryFormat' is
  // not defined in the arguments.") for any transparent re-export.

  const hasRouterConfig =
    typeof config.remoteToolFromArg === 'string' && config.remoteToolFromArg
      || typeof config.remoteArgumentsFromArg === 'string' && config.remoteArgumentsFromArg;

  const remoteToolField = typeof config.remoteToolFromArg === 'string' && config.remoteToolFromArg
    ? config.remoteToolFromArg
    : 'tool';
  const remoteArgsField = typeof config.remoteArgumentsFromArg === 'string' && config.remoteArgumentsFromArg
    ? config.remoteArgumentsFromArg
    : 'arguments';

  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

  let remoteTool;
  let remoteArguments;

  if (typeof config.remoteTool === 'string' && config.remoteTool) {
    // Convention #2: pinned remote name; forward args verbatim.
    remoteTool = config.remoteTool;
    remoteArguments = safeArgs;
  } else if (hasRouterConfig) {
    // Convention #1: router envelope; pull the named fields out of args.
    remoteTool = typeof safeArgs[remoteToolField] === 'string' && safeArgs[remoteToolField].trim()
      ? safeArgs[remoteToolField].trim()
      : tool.name;
    remoteArguments = safeArgs[remoteArgsField] && typeof safeArgs[remoteArgsField] === 'object' && !Array.isArray(safeArgs[remoteArgsField])
      ? safeArgs[remoteArgsField]
      : {};
  } else {
    // Convention #3: transparent passthrough using the local tool name.
    remoteTool = tool.name;
    remoteArguments = safeArgs;
  }

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

  const response = await callRemoteMcpTool(connection, remoteCall.remoteTool, remoteCall.remoteArguments);
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
}