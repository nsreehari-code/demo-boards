/**
 * agentface-mcp.js — Streamable HTTP MCP endpoint co-hosted in the controlface server.
 *
 * Exposes the same tool surface that controlface already serves over its raw HTTP
 * routes (`/mcp`, `/mcp-raw`, `/mcp-extras`) as a single formal MCP endpoint at
 * `/agent/mcp`, plus a catalog document at `/agent/mcp/manifest`.
 *
 * Design:
 * - The MCP protocol/transport lives here (network concern), not in the shared
 *   board server-runtime (which also runs in the browser and queue-runner).
 * - Tool execution is dispatched IN-PROCESS into the same board runtime that the
 *   HTTP routes use (`entry.runtime.handleRuntimeApi`) — no loopback fetch, no hop
 *   through the standalone mcp-server on 7801.
 * - The tool catalog (names, JSON Schemas, route kinds) is read from the existing
 *   liveboards manifest so there is a single source of truth.
 *
 * MCP unifies json vs raw responses: a single `tools/call` returns content blocks
 * that may be text, image, audio, or resource (blob). There is therefore no need
 * for a separate `/agent/mcp-raw` endpoint — raw tools are framed into content
 * blocks here, exactly like the standalone liveboards handler does.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentfaceMcpSurface } from './controlface-mcp-surface.js';

const AGENT_MCP_PATH = '/agent/mcp';
const AGENT_MCP_MANIFEST_PATH = '/agent/mcp/manifest';

const SERVER_NAME = 'demo-boards-agentface';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Small HTTP helpers (kept local to avoid coupling to controlface internals).
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
  res.end(message);
}

function isInitializeRequest(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  if (!body) return null;
  return JSON.parse(body);
}

function headerSessionId(req) {
  const raw = req.headers['mcp-session-id'];
  return Array.isArray(raw) ? raw[0] : raw;
}

function createMcpServer(deps) {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.surface.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = typeof request?.params?.name === 'string' ? request.params.name.trim() : '';
    const args = request?.params?.arguments;
    return deps.surface.callTool(name, args);
  });

  return server;
}

/**
 * Create the agentface MCP request handler.
 *
 * @param {object} options
 * @param {object} options.hostConfig  Resolved controlface host config (needs apiBasePrefix/host/port).
 * @param {Map}    options.boardRuntimes  Map<boardId, { runtime }>.
 * @param {object} [options.logger]  Optional logger with info/warn.
 * @param {string} [options.manifestPath]  Override path to the tool catalog manifest.
 */
export function createAgentMcpHandler({ hostConfig, boardRuntimes, logger = null, manifestPath } = {}) {
  if (!hostConfig || typeof hostConfig !== 'object') {
    throw new Error('createAgentMcpHandler requires hostConfig');
  }
  if (!(boardRuntimes instanceof Map)) {
    throw new Error('createAgentMcpHandler requires boardRuntimes Map');
  }

  const surface = createAgentfaceMcpSurface({
    hostConfig,
    boardRuntimes,
    manifestPath,
    endpoint: AGENT_MCP_PATH,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    defaultDescription: 'Agentface MCP surface co-hosted in controlface.',
  });
  const deps = { surface };

  const sessionTransports = new Map();
  const sessionServers = new Map();

  function log(message) {
    if (logger && typeof logger.info === 'function') {
      logger.info(`[agentface] ${message}`);
    }
  }

  log(`loaded ${surface.toolCount} tools from ${surface.manifestPath}`);

  async function handleRequest(req, res, parsedUrl, parsedBodyOverride = undefined) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (parsedUrl.pathname === AGENT_MCP_MANIFEST_PATH) {
      if (req.method !== 'GET') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      sendJson(res, 200, surface.manifestDocument);
      return;
    }

    const sessionId = headerSessionId(req);

    if (req.method === 'POST') {
      const parsedBody = parsedBodyOverride === undefined
        ? await readJsonBody(req)
        : parsedBodyOverride;

      if (sessionId && sessionTransports.has(sessionId)) {
        await sessionTransports.get(sessionId).handleRequest(req, res, parsedBody);
        return;
      }

      if (!sessionId && isInitializeRequest(parsedBody)) {
        const server = createMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            sessionTransports.set(initializedSessionId, transport);
            sessionServers.set(initializedSessionId, server);
          },
        });
        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (activeSessionId) {
            sessionTransports.delete(activeSessionId);
            sessionServers.delete(activeSessionId);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
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
  }

  async function close() {
    const sessions = new Set([...sessionServers.keys(), ...sessionTransports.keys()]);
    for (const id of sessions) {
      try {
        await sessionTransports.get(id)?.close();
      } catch {}
      try {
        await sessionServers.get(id)?.close();
      } catch {}
    }
    sessionTransports.clear();
    sessionServers.clear();
  }

  return {
    handleRequest,
    close,
    paths: { mcp: AGENT_MCP_PATH, manifest: AGENT_MCP_MANIFEST_PATH },
    manifestPath: surface.manifestPath,
    toolCount: surface.toolCount,
  };
}

export const AGENT_MCP_PATHS = { mcp: AGENT_MCP_PATH, manifest: AGENT_MCP_MANIFEST_PATH };
