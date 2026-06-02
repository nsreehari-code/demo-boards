#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHttpBoardCallbackTransport } from 'yaml-flow/board-live-cards-node';
import { buildBoardBundle } from '../server-firebase-shared/build-board-bundle.js';
import { initializeFirebaseServices } from '../server-firebase-shared/firebase-init.js';
import { loadLegacyBoardChatRuntime } from '../server-firebase-shared/legacy-chat-runtime.js';
import { loadFirebaseHostConfig } from '../server-firebase-shared/load-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, 'controlface-server.config.json');

function createLogger(scope) {
  return {
    info: (msg, ...args) => console.log(`[${scope}] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[${scope}] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${scope}] ${msg}`, ...args),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-file-name',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(body);
}

function buildBoardRuntimes(hostConfig, firebaseServices) {
  const runtimes = new Map();
  for (const [boardId, boardConfig] of Object.entries(hostConfig.boards)) {
    const callbackBaseUrl = `http://${hostConfig.host}:${hostConfig.port}${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}/mcp-webhooks`;
    const bundle = buildBoardBundle(
      boardId,
      boardConfig,
      firebaseServices,
      {},
      { callbackTransport: createHttpBoardCallbackTransport(callbackBaseUrl) },
    );
    const chatRuntime = loadLegacyBoardChatRuntime(boardId, boardConfig, {
      serverUrl: `http://${hostConfig.host}:${hostConfig.port}`,
      apiBasePrefix: hostConfig.apiBasePrefix,
    });
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: `${hostConfig.apiBasePrefix}/${encodeURIComponent(boardId)}`,
      boardId,
      boards: [{
        ...bundle.boardContextConfig,
        ...(chatRuntime.chatHandlerFlow ? { chatHandlerFlow: chatRuntime.chatHandlerFlow } : {}),
      }],
      invocationAdapter: {
        async invoke(ref) {
          return {
            dispatched: false,
            error: `No invocation adapter configured for ${ref?.howToRun || 'unknown'}`,
          };
        },
      },
      executionExtra: chatRuntime.executionExtra,
      logger: createLogger(`controlface:${boardId}`),
    });
    runtimes.set(boardId, runtime);
  }
  return runtimes;
}

async function main() {
  const hostConfig = loadFirebaseHostConfig(DEFAULT_CONFIG_PATH);
  const firebaseServices = await initializeFirebaseServices(hostConfig.firebase);
  const boardRuntimes = buildBoardRuntimes(hostConfig, firebaseServices);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,x-file-name',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${hostConfig.host}:${hostConfig.port}`);
    if (req.method === 'GET' && parsedUrl.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        boards: Array.from(boardRuntimes.keys()),
      });
      return;
    }

    try {
      for (const runtime of boardRuntimes.values()) {
        if (await runtime.handleRuntimeApi(req, res, parsedUrl)) {
          return;
        }
      }
      sendJson(res, 404, {
        error: 'not found',
        path: parsedUrl.pathname,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  server.listen(hostConfig.port, hostConfig.host, () => {
    console.log(`[controlface-firebase] Listening on http://${hostConfig.host}:${hostConfig.port}`);
    console.log(`[controlface-firebase] Boards: ${Array.from(boardRuntimes.keys()).join(', ')}`);
  });
}

main().catch((error) => {
  console.error(`[controlface-firebase] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
