(function (global) {
  var AGENT_MCP_PATH = '/agent/mcp';
  var AGENT_MCP_MANIFEST_PATH = '/agent/mcp/manifest';

  function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
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
    var surface = deps.surface && typeof deps.surface === 'object' ? deps.surface : null;
    if (!surface || typeof surface.listTools !== 'function' || typeof surface.callTool !== 'function' || !surface.manifestDocument) {
      throw new Error('createEmbeddedAgentfaceMcp requires deps.surface with manifestDocument, listTools(), and callTool()');
    }
    var sessions = {};

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
        return createJsonResponse(200, surface.manifestDocument, {
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
              tools: surface.listTools(),
            }), {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            });
          }
          if (rpcMethod === 'tools/call') {
            var toolName = normalizeOptionalString(params.name);
            var result = await surface.callTool(toolName, params.arguments);
            return createJsonResponse(200, jsonRpcSuccess(parsedBody.id, result), {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            });
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
      toolCount: Number(surface.toolCount) || surface.listTools().length,
    };
  }

  global.AgentfaceEmbeddedShared = {
    createEmbeddedAgentfaceMcp: createEmbeddedAgentfaceMcp,
    paths: { mcp: AGENT_MCP_PATH, manifest: AGENT_MCP_MANIFEST_PATH },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);