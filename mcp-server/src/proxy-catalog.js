import * as z from 'zod/v4';
import {
  authenticateRemoteMcp,
  callRemoteMcpTool,
  listRemoteMcpTools,
} from './handlers/mcp-proxy.js';

const MANAGEMENT_TOOL_NAMES = [
  'proxy.auth_status',
  'proxy.sign_in',
  'proxy.refresh_tools',
];

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function errorMessage(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').trim();
}

export class ProxyCatalog {
  constructor(entries, localToolNames = []) {
    this.entries = new Map(entries.map((entry) => [entry.serverName, {
      ...entry,
      state: 'pending',
      tools: [],
      lastError: '',
      lastUpdatedAt: '',
    }]));
    this.localToolNames = new Set([...localToolNames, ...MANAGEMENT_TOOL_NAMES]);
    this.attachedServers = new Map();
  }

  async initialize() {
    for (const entry of this.entries.values()) {
      const result = await this.discover(entry);
      if (!result.ok && !entry.optional) {
        throw new Error(`Unable to discover MCP proxy "${entry.serverName}": ${result.error}`);
      }
    }
  }

  attach(server) {
    const attached = { proxyHandles: [] };
    this.attachedServers.set(server, attached);
    this.registerManagementTools(server);
    this.reconcileServer(server, attached);
  }

  detach(server) {
    this.attachedServers.delete(server);
  }

  getTools() {
    return Array.from(this.entries.values()).flatMap((entry) => entry.tools);
  }

  getStatuses(serverName) {
    const entries = serverName ? [this.entries.get(serverName)].filter(Boolean) : Array.from(this.entries.values());
    return entries.map((entry) => ({
      serverName: entry.serverName,
      state: entry.state,
      toolCount: entry.tools.length,
      authType: entry.connection?.auth?.type || 'none',
      lastError: entry.lastError,
      lastUpdatedAt: entry.lastUpdatedAt,
    }));
  }

  selectEntries(serverName) {
    if (!serverName) return Array.from(this.entries.values());
    const entry = this.entries.get(serverName);
    if (!entry) {
      throw new Error(`Unknown MCP proxy server: ${serverName}`);
    }
    return [entry];
  }

  async discover(entry) {
    try {
      const discovered = await listRemoteMcpTools(entry.connection);
      const prefix = typeof entry.toolNamePrefix === 'string' ? entry.toolNamePrefix : '';
      const tools = discovered.tools.map((remoteTool) => ({
        ...remoteTool,
        name: `${prefix}${remoteTool.name}`,
        inputSchema: remoteTool.inputSchema || {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        remoteToolName: remoteTool.name,
        proxyConnection: entry.connection,
        proxyServerName: entry.serverName,
      }));
      this.validateTools(entry.serverName, tools);
      entry.tools = tools;
      entry.state = 'ready';
      entry.lastError = '';
      entry.lastUpdatedAt = new Date().toISOString();
      process.stderr.write(`[mcp-server] Discovered ${tools.length} tools from proxy "${entry.serverName}"\n`);
      return { ok: true, toolCount: tools.length };
    } catch (error) {
      entry.state = 'unavailable';
      entry.lastError = errorMessage(error);
      entry.lastUpdatedAt = new Date().toISOString();
      process.stderr.write(`[mcp-server] Proxy "${entry.serverName}" unavailable: ${entry.lastError}\n`);
      return { ok: false, error: entry.lastError, toolCount: entry.tools.length };
    }
  }

  validateTools(serverName, candidateTools) {
    const names = new Set(this.localToolNames);
    for (const entry of this.entries.values()) {
      const tools = entry.serverName === serverName ? candidateTools : entry.tools;
      for (const tool of tools) {
        if (names.has(tool.name)) {
          throw new Error(
            `Duplicate MCP tool name from proxy "${entry.serverName}": ${tool.name}. `
            + 'Set proxy.toolNamePrefix to disambiguate it.'
          );
        }
        names.add(tool.name);
      }
    }
  }

  async refresh(serverName) {
    const results = [];
    for (const entry of this.selectEntries(serverName)) {
      results.push({ serverName: entry.serverName, ...await this.discover(entry) });
    }
    this.reconcileAllServers();
    return results;
  }

  async signIn(serverName, forceLogin) {
    const authentication = [];
    for (const entry of this.selectEntries(serverName)) {
      try {
        const result = await authenticateRemoteMcp(entry.connection, { forceLogin });
        authentication.push({ serverName: entry.serverName, ok: true, ...result });
      } catch (error) {
        authentication.push({ serverName: entry.serverName, ok: false, error: errorMessage(error) });
      }
    }
    const refresh = await this.refresh(serverName);
    return { authentication, refresh };
  }

  reconcileAllServers() {
    for (const [server, attached] of this.attachedServers) {
      this.reconcileServer(server, attached);
    }
  }

  reconcileServer(server, attached) {
    for (const handle of attached.proxyHandles) handle.remove();
    attached.proxyHandles = this.getTools().map((tool) => server.registerTool(
      tool.name,
      {
        title: tool.title || tool.name,
        description: tool.description || '',
        inputSchema: z.fromJSONSchema(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: z.fromJSONSchema(tool.outputSchema) } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      (args) => callRemoteMcpTool(tool.proxyConnection, tool.remoteToolName, args),
    ));
  }

  registerManagementTools(server) {
    server.registerTool(
      'proxy.auth_status',
      {
        title: 'Proxy Authentication Status',
        description: 'Show discovery and authentication state for configured upstream MCP proxies.',
        inputSchema: { serverName: z.string().optional() },
      },
      (args) => toolResult({ proxies: this.getStatuses(args.serverName) }),
    );
    server.registerTool(
      'proxy.sign_in',
      {
        title: 'Sign In To MCP Proxy',
        description: 'Check cached authentication and refresh an upstream MCP proxy. Interactive sign-in occurs only when forceLogin is true.',
        inputSchema: {
          serverName: z.string().optional(),
          forceLogin: z.boolean().optional().describe('Open the configured interactive login even if a cached token exists.'),
        },
      },
      async (args) => toolResult(await this.signIn(args.serverName, args.forceLogin === true)),
    );
    server.registerTool(
      'proxy.refresh_tools',
      {
        title: 'Refresh MCP Proxy Tools',
        description: 'Rediscover tools from one or all configured upstream MCP proxies.',
        inputSchema: { serverName: z.string().optional() },
      },
      async (args) => toolResult({ refresh: await this.refresh(args.serverName) }),
    );
  }
}