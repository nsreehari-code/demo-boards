#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:7799';
const DEFAULT_AGENTFACE_PATH = '/agent/mcp';
const DEFAULT_TOOL = 'liveboards.explore.list-sample-templates';

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

async function importMcpClientModules() {
  const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');

  let streamableModule = null;
  try {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  } catch {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamable-http.js');
  }

  return {
    Client: clientModule.Client,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
  };
}

function normalizeToolResult(response) {
  const structured = response?.structuredContent;
  if (
    structured
    && typeof structured === 'object'
    && !Array.isArray(structured)
    && Object.keys(structured).length === 1
    && Object.prototype.hasOwnProperty.call(structured, 'result')
  ) {
    return structured.result;
  }

  const content = Array.isArray(response?.content) ? response.content : [];
  const firstText = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  if (firstText) {
    try {
      return JSON.parse(firstText.text);
    } catch {
      return firstText.text;
    }
  }

  return structured ?? response;
}

async function fetchHealthz(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    if (!response.ok) {
      return { ok: false, reason: `healthz ${response.status}` };
    }
    const payload = await response.json().catch(() => null);
    return { ok: payload?.ok !== false, payload };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.DEMO_BOARDS_BASE_URL || process.env.CONTROLFACE_BASE_URL);
  const healthz = await fetchHealthz(baseUrl);
  if (!healthz.ok) {
    console.log(`[agentface-smoke] skipping: hosted controlface is not available at ${baseUrl} (${healthz.reason || 'not ready'})`);
    return;
  }

  const mcpUrl = `${baseUrl}${DEFAULT_AGENTFACE_PATH}`;
  console.log(`\n=== agentface MCP smoke test ===`);
  console.log(`target: ${mcpUrl}`);
  console.log(`tool:   ${DEFAULT_TOOL}`);

  const { Client, StreamableHTTPClientTransport } = await importMcpClientModules();
  const client = new Client(
    { name: 'demo-boards-agentface-smoke', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  try {
    await client.connect(transport);
    const listResult = await client.listTools();
    const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    if (tools.length === 0) {
      throw new Error('agentface tools/list returned no tools');
    }
    const tool = tools.find((entry) => entry?.name === DEFAULT_TOOL);
    if (!tool) {
      throw new Error(`agentface tools/list did not include ${DEFAULT_TOOL}`);
    }

    const callResult = await client.callTool({ name: DEFAULT_TOOL, arguments: {} });
    const payload = normalizeToolResult(callResult);
    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : (Array.isArray(payload?.data?.entries) ? payload.data.entries : (Array.isArray(payload) ? payload : []));
    if (entries.length === 0) {
      throw new Error(`${DEFAULT_TOOL} returned no entries`);
    }

    console.log(`[agentface-smoke] tools/list ok: ${tools.length} tools`);
    console.log(`[agentface-smoke] ${DEFAULT_TOOL} ok: ${entries.length} entries`);
  } finally {
    if (typeof transport.close === 'function') {
      await transport.close().catch(() => {});
    }
    if (typeof client.close === 'function') {
      await client.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});