import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BOARD_SERVER_URL = 'http://127.0.0.1:7799';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVEBOARDS_CONFIG_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'liveboards.config.json',
);

function asPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function toJsonToolResult(result) {
  const text = typeof result === 'string' ? result : asPrettyJson(result);
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent: result,
  };
}

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

function toRawToolResult(toolName, boardId, args, response) {
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
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const kind = classifyMimeType(mimeType);
  const meta = {
    'liveboards/raw-tool': toolName,
    'liveboards/mime-type': mimeType,
    'liveboards/resource-uri': resourceUri,
  };

  if (kind === 'text') {
    return {
      content: [{ type: 'text', text: decodeTextual(response.bodyBytes, mimeType) }],
      _meta: meta,
    };
  }

  const base64 = Buffer.from(response.bodyBytes).toString('base64');

  if (kind === 'image') {
    return {
      content: [{ type: 'image', data: base64, mimeType }],
      _meta: meta,
    };
  }

  if (kind === 'audio') {
    return {
      content: [{ type: 'audio', data: base64, mimeType }],
      _meta: meta,
    };
  }

  return {
    content: [
      {
        type: 'resource',
        resource: {
          uri: resourceUri,
          mimeType,
          blob: base64,
        },
      },
    ],
    _meta: meta,
  };
}

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function loadLiveboardsConfig(tool) {
  const configuredPath = typeof tool?.config?.configPath === 'string' && tool.config.configPath.trim()
    ? tool.config.configPath.trim()
    : LIVEBOARDS_CONFIG_FILE;
  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(path.dirname(tool?.manifestPath || LIVEBOARDS_CONFIG_FILE), configuredPath);

  let config = {};
  try {
    config = ensureObject(readJsonFile(absolutePath), `liveboards config ${absolutePath}`);
  } catch (error) {
    if (absolutePath !== LIVEBOARDS_CONFIG_FILE) {
      throw error;
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      config = {};
    } else {
      throw error;
    }
  }

  const envOverride = typeof process.env.DEMO_BOARD_SERVER_URL === 'string' && process.env.DEMO_BOARD_SERVER_URL.trim()
    ? process.env.DEMO_BOARD_SERVER_URL.trim()
    : null;

  const boardServerUrl = envOverride
    ?? (typeof config.boardServerUrl === 'string' && config.boardServerUrl.trim()
      ? config.boardServerUrl.trim()
      : DEFAULT_BOARD_SERVER_URL);

  return {
    boardServerUrl,
    configPath: absolutePath,
  };
}

function requireBoardId(args) {
  const boardId = typeof args?.board_id === 'string' ? args.board_id.trim() : '';
  if (!boardId) {
    throw new Error('board_id is required — pass the board ID as the board_id argument');
  }
  return boardId;
}

function isBoardScopedTool(tool) {
  return tool?.config?.boardScoped !== false;
}

function resolveRouteKind(tool, upstreamTool) {
  const configuredRouteKind = typeof tool?.config?.routeKind === 'string' ? tool.config.routeKind.trim() : '';
  if (configuredRouteKind) {
    return configuredRouteKind;
  }
  return upstreamTool === 'inspect.file-contents' ? 'mcp-raw' : 'mcp';
}

function resolveUpstreamTool(tool) {
  const configuredTool = typeof tool?.config?.remoteTool === 'string' && tool.config.remoteTool.trim()
    ? tool.config.remoteTool.trim()
    : '';
  if (configuredTool) {
    return configuredTool;
  }

  const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
  if (!name.startsWith('liveboards.')) {
    throw new Error(`Unable to resolve liveboards upstream tool from name: ${name || '<empty>'}`);
  }
  return name.slice('liveboards.'.length);
}

function stripLocalArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  const { board_id, ...rest } = args;
  void board_id;
  return rest;
}

async function callBoardServer(routeUrl, payload, responseType) {
  const response = await fetch(routeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (responseType === 'raw') {
    const bodyBytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const errorText = bodyBytes.toString('utf8').trim();
      throw new Error(errorText || `Board server request failed (${response.status})`);
    }
    return {
      headers: response.headers,
      bodyBytes,
    };
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(bodyText.trim() || `Board server request failed (${response.status})`);
  }

  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Board server returned invalid JSON: ${detail}`);
  }
}

export async function handleLiveboardsTool(args, tool) {
  const upstreamTool = resolveUpstreamTool(tool);
  const routeKind = resolveRouteKind(tool, upstreamTool);
  const boardScoped = isBoardScopedTool(tool);
  const boardId = boardScoped ? requireBoardId(args) : '';
  const upstreamArgs = stripLocalArgs(args);
  const liveboardsConfig = loadLiveboardsConfig(tool);
  const boardServerBaseUrl = liveboardsConfig.boardServerUrl.replace(/\/+$/, '');
  const isRawTool = routeKind === 'mcp-raw';
  const routeUrl = boardScoped
    ? `${boardServerBaseUrl}/api/boards/${encodeURIComponent(boardId)}/${routeKind}`
    : `${boardServerBaseUrl}/${routeKind}`;
  const payload = {
    tool: upstreamTool,
    args: upstreamArgs,
  };

  if (isRawTool) {
    const response = await callBoardServer(routeUrl, payload, 'raw');
    return toRawToolResult(upstreamTool, boardId, upstreamArgs, response);
  }

  const result = await callBoardServer(routeUrl, payload, 'json');
  return toJsonToolResult(result);
}