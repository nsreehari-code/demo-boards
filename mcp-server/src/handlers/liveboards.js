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

  return {
    content: [
      {
        type: 'resource',
        resource: {
          uri: `liveboards://${encodeURIComponent(boardId)}/${resourceName}`,
          mimeType: response.headers.get('content-type') || 'application/octet-stream',
          blob: Buffer.from(response.bodyBytes).toString('base64'),
        },
      },
    ],
    _meta: {
      'liveboards/raw-tool': toolName,
    },
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

  const boardServerUrl = typeof config.boardServerUrl === 'string' && config.boardServerUrl.trim()
    ? config.boardServerUrl.trim()
    : DEFAULT_BOARD_SERVER_URL;

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
  const boardId = requireBoardId(args);
  const upstreamTool = resolveUpstreamTool(tool);
  const upstreamArgs = stripLocalArgs(args);
  const liveboardsConfig = loadLiveboardsConfig(tool);
  const boardServerBaseUrl = liveboardsConfig.boardServerUrl.replace(/\/+$/, '');
  const isRawTool = upstreamTool === 'inspect.file-contents';
  const routePath = isRawTool ? 'mcp-raw' : 'mcp';
  const routeUrl = `${boardServerBaseUrl}/api/boards/${encodeURIComponent(boardId)}/${routePath}`;
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