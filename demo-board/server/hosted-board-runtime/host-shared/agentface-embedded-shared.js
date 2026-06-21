(function (global) {
  var AGENT_MCP_PATH = '/agent/mcp';
  var AGENT_MCP_MANIFEST_PATH = '/agent/mcp/manifest';
  var SERVER_NAME = 'demo-boards-agentface';
  var SERVER_VERSION = '0.1.0';

  function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function cloneJsonValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function createJsonResponse(statusCode, payload, headers) {
    return JSON.stringify({
      statusCode: statusCode,
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}),
      body: JSON.stringify(payload),
    }, null, 2);
  }

  function createTextResponse(statusCode, text, headers) {
    return JSON.stringify({
      statusCode: statusCode,
      headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, headers || {}),
      body: String(text || ''),
    }, null, 2);
  }

  function jsonRpcSuccess(id, result) {
    return { jsonrpc: '2.0', id: id == null ? null : id, result: result };
  }

  function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id == null ? null : id, error: { code: code, message: message } };
  }

  function isInitializeRequest(body) {
    return !!body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
  }

  function resolveRouteKind(tool) {
    var configured = normalizeOptionalString(tool && tool.config && tool.config.routeKind);
    if (configured) return configured;
    var remoteTool = resolveRemoteTool(tool);
    return remoteTool === 'inspect.file-contents' ? 'mcp-raw' : 'mcp';
  }

  function resolveRemoteTool(tool) {
    var configured = normalizeOptionalString(tool && tool.config && tool.config.remoteTool);
    if (configured) return configured;
    var name = normalizeOptionalString(tool && tool.name);
    return name.indexOf('liveboards.') === 0 ? name.slice('liveboards.'.length) : name;
  }

  function isBoardScoped(tool) {
    return !(tool && tool.config && tool.config.boardScoped === false);
  }

  function requireBoardId(args) {
    var boardId = normalizeOptionalString(args && (args.board_id || args.boardId));
    if (!boardId) {
      throw new Error('board_id is required — pass the board ID as the board_id argument');
    }
    return boardId;
  }

  function stripBoardId(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    var rest = {};
    Object.keys(args).forEach(function (key) {
      if (key !== 'board_id' && key !== 'boardId') {
        rest[key] = args[key];
      }
    });
    return rest;
  }

  function classifyMimeType(mimeType) {
    var baseType = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!baseType) return 'binary';
    if (baseType.indexOf('text/') === 0) return 'text';
    if (baseType.indexOf('image/') === 0) return 'image';
    if (baseType.indexOf('audio/') === 0) return 'audio';
    if (
      baseType === 'application/json'
      || baseType === 'application/xml'
      || baseType === 'application/javascript'
      || baseType === 'application/x-yaml'
      || baseType === 'application/yaml'
      || /\+json$/.test(baseType)
      || /\+xml$/.test(baseType)
    ) {
      return 'text';
    }
    return 'binary';
  }

  function decodeBase64Utf8(base64) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64').toString('utf8');
    }
    if (typeof atob === 'function') {
      return decodeURIComponent(escape(atob(base64)));
    }
    throw new Error('No base64 decoder available');
  }

  function toJsonToolResult(result) {
    var text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      content: [{ type: 'text', text: text }],
      structuredContent: result == null ? { result: null } : { result: result },
    };
  }

  function toRawToolResult(remoteTool, boardId, args, responsePayload) {
    var cardId = normalizeOptionalString(args && (args.card_id || args.cardId)) || 'unknown-card';
    var fileIdx = Number.isInteger(args && args.file_idx) ? args.file_idx : parseInt(String(args && (args.file_idx || args.fileIdx) || ''), 10);
    var resourceName = Number.isInteger(fileIdx) ? cardId + '/attachments/' + fileIdx : cardId + '/attachments/raw';
    var resourceUri = 'liveboards://' + encodeURIComponent(boardId) + '/' + resourceName;
    var mimeType = normalizeOptionalString(responsePayload && responsePayload.mimeType) || 'application/octet-stream';
    var kind = classifyMimeType(mimeType);
    var base64 = normalizeOptionalString(responsePayload && responsePayload.bodyBase64);
    var meta = {
      'liveboards/raw-tool': remoteTool,
      'liveboards/mime-type': mimeType,
      'liveboards/resource-uri': resourceUri,
    };

    if (kind === 'text') {
      return {
        content: [{ type: 'text', text: decodeBase64Utf8(base64) }],
        _meta: meta,
      };
    }
    if (kind === 'image') {
      return { content: [{ type: 'image', data: base64, mimeType: mimeType }], _meta: meta };
    }
    if (kind === 'audio') {
      return { content: [{ type: 'audio', data: base64, mimeType: mimeType }], _meta: meta };
    }
    return {
      content: [{ type: 'resource', resource: { uri: resourceUri, mimeType: mimeType, blob: base64 } }],
      _meta: meta,
    };
  }

  function createAgentManifestDocument(manifest, tools) {
    return {
      server: {
        name: manifest && manifest.server && manifest.server.name || SERVER_NAME,
        version: manifest && manifest.server && manifest.server.version || SERVER_VERSION,
        description: manifest && manifest.server && manifest.server.description || 'Agentface MCP surface co-hosted in controlface.',
      },
      endpoint: AGENT_MCP_PATH,
      tools: tools.map(function (tool) {
        return {
          name: tool.name,
          title: tool.title || tool.name,
          description: tool.description || '',
          routeKind: resolveRouteKind(tool),
          boardScoped: isBoardScoped(tool),
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        };
      }),
    };
  }

  function createSessionId() {
    if (!global.__embeddedAgentfaceSessionCounter) {
      global.__embeddedAgentfaceSessionCounter = 0;
    }
    global.__embeddedAgentfaceSessionCounter += 1;
    return 'embedded-agentface-' + String(global.__embeddedAgentfaceSessionCounter).padStart(6, '0');
  }

  function createEmbeddedAgentfaceMcp(deps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('createEmbeddedAgentfaceMcp requires deps');
    }
    var manifest = deps.manifest && typeof deps.manifest === 'object' ? deps.manifest : {};
    var tools = Array.isArray(manifest.tools) ? manifest.tools : [];
    var toolByName = {};
    tools.forEach(function (tool) {
      if (tool && typeof tool.name === 'string' && tool.name.trim()) {
        toolByName[tool.name.trim()] = tool;
      }
    });
    var sessions = {};

    async function executeToolCall(name, args) {
      var tool = toolByName[name];
      if (!tool) {
        throw new Error("unknown tool '" + name + "'");
      }
      var routeKind = resolveRouteKind(tool);
      var remoteTool = resolveRemoteTool(tool);
      var safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

      if (routeKind === 'mcp-extras') {
        var extrasRaw = await deps.invokeHttpRoute('POST', '/mcp-extras', JSON.stringify({ tool: remoteTool, args: safeArgs }));
        var extrasEnvelope = JSON.parse(extrasRaw);
        var extrasPayload = extrasEnvelope.body ? JSON.parse(extrasEnvelope.body) : null;
        if ((extrasEnvelope.statusCode || 0) >= 400) {
          throw new Error(extrasPayload && extrasPayload.error ? extrasPayload.error : 'mcp-extras failed');
        }
        return { kind: 'json', payload: extrasPayload };
      }

      var boardScoped = isBoardScoped(tool);
      var boardId = boardScoped ? requireBoardId(safeArgs) : '';
      var upstreamArgs = stripBoardId(safeArgs);
      var routePath = routeKind === 'mcp-raw' ? '/mcp-raw?resp=json-b64' : '/' + routeKind;
      var raw = await deps.invokeHttpRoute('POST', routePath, JSON.stringify({ tool: remoteTool, args: upstreamArgs }));
      var envelope = JSON.parse(raw);
      var payload = envelope.body ? JSON.parse(envelope.body) : null;
      if ((envelope.statusCode || 0) >= 400) {
        throw new Error(payload && payload.error ? payload.error : remoteTool + ' failed');
      }
      if (routeKind === 'mcp-raw') {
        return { kind: 'raw', remoteTool: remoteTool, boardId: boardId, upstreamArgs: upstreamArgs, payload: payload };
      }
      return { kind: 'json', payload: payload };
    }

    async function handleRequest(method, path, bodyText, headers) {
      var normalizedMethod = String(method || 'GET').toUpperCase();
      var normalizedPath = String(path || '').split('?')[0] || '/';
      var sessionId = normalizeOptionalString(headers && (headers['mcp-session-id'] || headers['Mcp-Session-Id'] || headers['MCP-SESSION-ID']));

      if (normalizedMethod === 'OPTIONS') {
        return createTextResponse(204, '', {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        });
      }

      if (normalizedPath === AGENT_MCP_MANIFEST_PATH) {
        if (normalizedMethod !== 'GET') {
          return createTextResponse(405, 'Method not allowed');
        }
        return createJsonResponse(200, createAgentManifestDocument(manifest, tools), {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        });
      }

      if (normalizedPath !== AGENT_MCP_PATH) {
        return createTextResponse(404, 'Not found');
      }

      try {
        if (normalizedMethod === 'POST') {
          var parsedBody = bodyText && String(bodyText).trim() ? JSON.parse(bodyText) : null;
          if (!sessionId && isInitializeRequest(parsedBody)) {
            var newSessionId = createSessionId();
            sessions[newSessionId] = { createdAt: Date.now() };
            return createJsonResponse(200, jsonRpcSuccess(parsedBody.id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            }), {
              'mcp-session-id': newSessionId,
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            });
          }

          if (!sessionId || !sessions[sessionId]) {
            return createJsonResponse(400, jsonRpcError(null, -32000, 'Bad Request: No valid session ID provided'), {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            });
          }

          var rpcMethod = normalizeOptionalString(parsedBody && parsedBody.method);
          var params = parsedBody && parsedBody.params && typeof parsedBody.params === 'object' && !Array.isArray(parsedBody.params) ? parsedBody.params : {};
          if (rpcMethod === 'tools/list') {
            return createJsonResponse(200, jsonRpcSuccess(parsedBody.id, {
              tools: tools.map(function (tool) {
                return {
                  name: tool.name,
                  title: tool.title || tool.name,
                  description: tool.description || '',
                  inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
                };
              }),
            }), {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            });
          }
          if (rpcMethod === 'tools/call') {
            var toolName = normalizeOptionalString(params.name);
            try {
              var outcome = await executeToolCall(toolName, params.arguments);
              var result = outcome.kind === 'raw'
                ? toRawToolResult(outcome.remoteTool, outcome.boardId, outcome.upstreamArgs, outcome.payload)
                : toJsonToolResult(outcome.payload);
              return createJsonResponse(200, jsonRpcSuccess(parsedBody.id, result), {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
                'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
              });
            } catch (error) {
              return createJsonResponse(200, jsonRpcSuccess(parsedBody.id, {
                content: [{ type: 'text', text: JSON.stringify({ error: toolName + ' failed: ' + (error && error.message ? error.message : String(error)) }) }],
                isError: true,
              }), {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
                'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
              });
            }
          }

          return createJsonResponse(200, jsonRpcError(parsedBody ? parsedBody.id : null, -32601, 'Method not found'), {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
            'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          });
        }

        if (normalizedMethod === 'GET' || normalizedMethod === 'DELETE') {
          if (!sessionId || !sessions[sessionId]) {
            return createTextResponse(400, 'Invalid or missing session ID');
          }
          if (normalizedMethod === 'DELETE') {
            delete sessions[sessionId];
            return createTextResponse(200, '');
          }
          return createTextResponse(200, '');
        }

        return createTextResponse(405, 'Method not allowed');
      } catch (error) {
        return createJsonResponse(500, jsonRpcError(null, -32603, error && error.message ? error.message : String(error)), {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        });
      }
    }

    return {
      handleRequest: handleRequest,
      paths: { mcp: AGENT_MCP_PATH, manifest: AGENT_MCP_MANIFEST_PATH },
      toolCount: tools.length,
    };
  }

  global.AgentfaceEmbeddedShared = {
    createEmbeddedAgentfaceMcp: createEmbeddedAgentfaceMcp,
    paths: { mcp: AGENT_MCP_PATH, manifest: AGENT_MCP_MANIFEST_PATH },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);