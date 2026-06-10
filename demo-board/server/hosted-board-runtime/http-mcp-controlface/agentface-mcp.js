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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createControlfaceMcpSurface } from './controlface-mcp-surface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ---------------------------------------------------------------------------
// Result framing — mirrors the standalone liveboards handler so json and raw
// tools produce identical MCP content shapes.
// ---------------------------------------------------------------------------

function classifyMimeType(mimeType) {
  const baseType = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!baseType) return 'binary';
  if (baseType.startsWith('text/')) return 'text';
  if (baseType.startsWith('image/')) return 'image';
  if (baseType.startsWith('audio/')) return 'audio';
  if (
    baseType === 'application/json'
    || baseType === 'application/xml'
    || baseType === 'application/javascript'
    || baseType === 'application/x-yaml'
    || baseType === 'application/yaml'
    || baseType.endsWith('+json')
    || baseType.endsWith('+xml')
  ) {
    return 'text';
  }
  return 'binary';
}

function decodeTextual(bodyBytes, mimeType) {
  try {
    const charsetMatch = /charset=([^;]+)/i.exec(String(mimeType || ''));
    const encoding = (charsetMatch?.[1] || 'utf8').trim().toLowerCase().replace(/^utf-/, 'utf');
    return Buffer.from(bodyBytes).toString(Buffer.isEncoding(encoding) ? encoding : 'utf8');
  } catch {
    return Buffer.from(bodyBytes).toString('utf8');
  }
}

function asPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function toJsonToolResult(result) {
  const text = typeof result === 'string' ? result : asPrettyJson(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result === null || result === undefined ? { result: null } : { result },
  };
}

function toRawToolResult(remoteTool, boardId, args, capture) {
  const cardId = typeof args?.card_id === 'string' && args.card_id.trim()
    ? args.card_id.trim()
    : 'unknown-card';
  const fileIdx = Number.isInteger(args?.file_idx)
    ? args.file_idx
    : Number.parseInt(String(args?.file_idx ?? ''), 10);
  const resourceName = Number.isInteger(fileIdx)
    ? `${cardId}/attachments/${fileIdx}`
    : `${cardId}/attachments/raw`;
  const resourceUri = `liveboards://${encodeURIComponent(boardId)}/${resourceName}`;
  const mimeType = capture.getHeader('content-type') || 'application/octet-stream';
  const kind = classifyMimeType(mimeType);
  const meta = {
    'liveboards/raw-tool': remoteTool,
    'liveboards/mime-type': mimeType,
    'liveboards/resource-uri': resourceUri,
  };

  if (kind === 'text') {
    return {
      content: [{ type: 'text', text: decodeTextual(capture.bodyBytes, mimeType) }],
      _meta: meta,
    };
  }

  const base64 = Buffer.from(capture.bodyBytes).toString('base64');

  if (kind === 'image') {
    return { content: [{ type: 'image', data: base64, mimeType }], _meta: meta };
  }
  if (kind === 'audio') {
    return { content: [{ type: 'audio', data: base64, mimeType }], _meta: meta };
  }

  return {
    content: [{ type: 'resource', resource: { uri: resourceUri, mimeType, blob: base64 } }],
    _meta: meta,
  };
}

// ---------------------------------------------------------------------------
// In-process board runtime invocation (json + raw capable).
// ---------------------------------------------------------------------------

function captureErrorMessage(capture, fallback) {
  const text = typeof capture.bodyText === 'string' ? capture.bodyText.trim() : '';
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      return text;
    }
    return text;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Tool catalog + dispatch.
// ---------------------------------------------------------------------------

function resolveRouteKind(tool) {
  const configured = typeof tool?.config?.routeKind === 'string' ? tool.config.routeKind.trim() : '';
  if (configured) return configured;
  const remoteTool = resolveRemoteTool(tool);
  return remoteTool === 'inspect.file-contents' ? 'mcp-raw' : 'mcp';
}

function resolveRemoteTool(tool) {
  const configured = typeof tool?.config?.remoteTool === 'string' && tool.config.remoteTool.trim()
    ? tool.config.remoteTool.trim()
    : '';
  if (configured) return configured;
  const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
  if (name.startsWith('liveboards.')) return name.slice('liveboards.'.length);
  return name;
}

function isBoardScoped(tool) {
  return tool?.config?.boardScoped !== false;
}

function requireBoardId(args) {
  const boardId = typeof args?.board_id === 'string' ? args.board_id.trim() : '';
  if (!boardId) {
    throw new Error('board_id is required — pass the board ID as the board_id argument');
  }
  return boardId;
}

function stripBoardId(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const { board_id, ...rest } = args;
  void board_id;
  return rest;
}

function dispatchExtrasTool(hostConfig, remoteTool, args) {
  if (remoteTool === 'explore.list-sample-templates') {
    return toJsonToolResult(listSampleTemplateEntries(hostConfig));
  }
  if (remoteTool === 'explore.get-sample-template') {
    const key = typeof args?.key === 'string'
      ? args.key.trim()
      : (typeof args?.templateKey === 'string' ? args.templateKey.trim() : '');
    return toJsonToolResult(getSampleTemplateEnvelope(hostConfig, key));
  }
  throw new Error(`unknown mcp-extras tool '${remoteTool}'`);
}

function createMcpServer(deps) {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.tools.map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = typeof request?.params?.name === 'string' ? request.params.name.trim() : '';
    const args = request?.params?.arguments;
    const tool = deps.toolByName.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool '${name}'` }) }],
        isError: true,
      };
    }
    try {
      const outcome = await deps.surface.executeToolCall(name, args);
      if (outcome.kind === 'raw') {
        return toRawToolResult(outcome.remoteTool, outcome.boardId, outcome.upstreamArgs, outcome.capture);
      }
      return toJsonToolResult(outcome.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `${name} failed: ${message}` }) }],
        isError: true,
      };
    }
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

  const surface = createControlfaceMcpSurface({ hostConfig, boardRuntimes, manifestPath });
  const manifestDocument = surface.getAgentManifestDocument({
    endpoint: AGENT_MCP_PATH,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    defaultDescription: 'Agentface MCP surface co-hosted in controlface.',
  });
  const deps = { surface, tools: surface.tools, toolByName: surface.toolByName };

  const sessionTransports = new Map();
  const sessionServers = new Map();

  function log(message) {
    if (logger && typeof logger.info === 'function') {
      logger.info(`[agentface] ${message}`);
    }
  }

  log(`loaded ${surface.toolCount} tools from ${surface.manifestPath}`);

  async function handleRequest(req, res, parsedUrl) {
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
      sendJson(res, 200, manifestDocument);
      return;
    }

    const sessionId = headerSessionId(req);

    if (req.method === 'POST') {
      const parsedBody = await readJsonBody(req);

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
