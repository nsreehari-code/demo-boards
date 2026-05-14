#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadManifests } from './manifest-loader.js';
import { resolveHandler } from './handler-registry.js';

function getArgValues(flag) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function getArgValue(flag, fallback) {
  const values = getArgValues(flag);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function validateTransportCompatibility(tools, transport) {
  if (transport !== 'stdio') return;

  const blocked = tools.filter(tool => tool.runtime?.requiresTerminalStdin);
  if (blocked.length === 0) return;

  const names = blocked.map(tool => tool.name).join(', ');
  throw new Error(
    `Transport mismatch: stdio cannot host tools requiring terminal-backed stdin: ${names}`
  );
}

function registerManifestTools(server, tools) {
  for (const tool of tools) {
    const handler = resolveHandler(tool.handler);
    server.registerTool(
      tool.name,
      {
        title: tool.title || tool.name,
        description: tool.description || '',
        ...(tool.inputSchema ? { inputSchema: convertJsonSchemaToZodShape(tool.inputSchema) } : {}),
      },
      async (args) => handler(args, tool)
    );
  }
}

function applySchemaConstraints(schema, spec) {
  if (typeof spec.description === 'string' && spec.description.trim()) {
    schema = schema.describe(spec.description.trim());
  }
  if (typeof spec.minLength === 'number' && typeof schema.min === 'function') {
    schema = schema.min(spec.minLength);
  }
  if (typeof spec.maxLength === 'number' && typeof schema.max === 'function') {
    schema = schema.max(spec.maxLength);
  }
  if (typeof spec.minimum === 'number' && typeof schema.gte === 'function') {
    schema = schema.gte(spec.minimum);
  }
  if (typeof spec.maximum === 'number' && typeof schema.lte === 'function') {
    schema = schema.lte(spec.maximum);
  }
  return schema;
}

function convertJsonSchemaNode(spec) {
  if (!spec || typeof spec !== 'object') {
    return z.any();
  }

  if (spec.type === 'string') {
    return applySchemaConstraints(z.string(), spec);
  }
  if (spec.type === 'integer') {
    return applySchemaConstraints(z.int(), spec);
  }
  if (spec.type === 'number') {
    return applySchemaConstraints(z.number(), spec);
  }
  if (spec.type === 'boolean') {
    return applySchemaConstraints(z.boolean(), spec);
  }
  if (spec.type === 'array') {
    const itemSchema = convertJsonSchemaNode(spec.items);
    let schema = z.array(itemSchema);
    if (typeof spec.minItems === 'number') schema = schema.min(spec.minItems);
    if (typeof spec.maxItems === 'number') schema = schema.max(spec.maxItems);
    return applySchemaConstraints(schema, spec);
  }
  if (spec.type === 'object') {
    return z.object(convertJsonSchemaToZodShape(spec));
  }

  return z.any();
}

function convertJsonSchemaToZodShape(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return {};
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => {
      let fieldSchema = convertJsonSchemaNode(value);
      if (!required.has(key)) {
        fieldSchema = fieldSchema.optional();
      }
      return [key, fieldSchema];
    }),
  );
}

function createMcpServer(loaded) {
  const server = new McpServer({
    name: loaded.server.name,
    version: loaded.server.version,
  });
  registerManifestTools(server, loaded.tools);
  return server;
}

function isInitializeRequest(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(message);
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  if (!body) return null;
  return JSON.parse(body);
}

async function closeAllSessions(sessionServers, sessionTransports) {
  const sessions = new Set([
    ...sessionServers.keys(),
    ...sessionTransports.keys(),
  ]);

  for (const sessionId of sessions) {
    const transport = sessionTransports.get(sessionId);
    const server = sessionServers.get(sessionId);
    try {
      if (transport) {
        await transport.close();
      }
    } catch {}
    try {
      if (server) {
        await server.close();
      }
    } catch {}
  }

  sessionServers.clear();
  sessionTransports.clear();
}

async function startStreamableHttpServer(loaded) {
  const host = getArgValue('--host', '127.0.0.1');
  const port = Number(getArgValue('--port', '7823'));
  const endpoint = getArgValue('--endpoint', '/mcp');
  const sessionTransports = new Map();
  const sessionServers = new Map();

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (requestUrl.pathname !== endpoint) {
      sendText(res, 404, 'Not found');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    try {
      if (req.method === 'POST') {
        const parsedBody = await readJsonBody(req);

        if (sessionId && sessionTransports.has(sessionId)) {
          await sessionTransports.get(sessionId).handleRequest(req, res, parsedBody);
          return;
        }

        if (!sessionId && isInitializeRequest(parsedBody)) {
          let transport;
          const mcpServer = createMcpServer(loaded);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
              sessionTransports.set(initializedSessionId, transport);
              sessionServers.set(initializedSessionId, mcpServer);
            },
          });
          transport.onclose = () => {
            const activeSessionId = transport.sessionId;
            if (activeSessionId) {
              sessionTransports.delete(activeSessionId);
              sessionServers.delete(activeSessionId);
            }
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId || !sessionTransports.has(sessionId)) {
          sendText(res, 400, 'Invalid or missing session ID');
          return;
        }
        await sessionTransports.get(sessionId).handleRequest(req, res);
        return;
      }

      sendText(res, 405, 'Method not allowed');
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: String(err?.message || err),
          },
          id: null,
        });
      }
    }
  });

  const shutdown = async () => {
    await closeAllSessions(sessionServers, sessionTransports);
    await new Promise((resolve) => httpServer.close(resolve));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  process.stdout.write(`[mcp-server] streamable-http listening on http://${host}:${port}${endpoint}\n`);
}

async function main() {
  const manifestPaths = getArgValues('--manifest');
  const transportName = getArgValue('--transport', 'stdio');
  const dryRun = hasFlag('--dry-run');

  const loaded = loadManifests(manifestPaths);
  validateTransportCompatibility(loaded.tools, transportName);

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          server: loaded.server,
          transport: transportName,
          toolCount: loaded.tools.length,
          tools: loaded.tools.map(tool => ({
            name: tool.name,
            handler: tool.handler,
            manifestPath: tool.manifestPath,
          })),
        },
        null,
        2,
      ) + '\n'
    );
    return;
  }

  if (transportName === 'stdio') {
    const server = createMcpServer(loaded);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (transportName === 'streamable-http') {
    await startStreamableHttpServer(loaded);
    return;
  }

  throw new Error(`Unsupported transport: ${transportName}`);
}

main().catch((err) => {
  process.stderr.write(`[mcp-server] ${String(err?.message || err)}\n`);
  process.exit(1);
});
