import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverRoot = path.resolve(import.meta.dirname, '..');
const upstreamPath = path.join(serverRoot, 'test', 'fixtures', 'mock-upstream-mcp.js');

test('registry MCP proxy discovers and transparently forwards upstream tools', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-e2e-'));
  const registryPath = path.join(tempDir, 'registry.json');
  const extraToolFile = path.join(tempDir, 'enable-extra-tool');
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await fs.writeFile(registryPath, JSON.stringify({
    servers: {
      upstream: {
        kind: 'mcp-proxy',
        proxy: {
          connection: {
            transport: 'stdio',
            command: process.execPath,
            args: [upstreamPath],
            env: {
              ...process.env,
              MOCK_UPSTREAM_EXTRA_TOOL_FILE: extraToolFile,
            },
          },
        },
      },
    },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/index.js', '--transport', 'stdio', '--registry', registryPath],
    cwd: serverRoot,
    env: process.env,
  });
  const client = new Client({ name: 'proxy-test-client', version: '0.1.0' });
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'proxy.auth_status',
    'proxy.refresh_tools',
    'proxy.sign_in',
    'upstream.echo',
  ]);
  const echoTool = listed.tools.find((tool) => tool.name === 'upstream.echo');
  assert.equal(echoTool.title, 'Upstream Echo');
  assert.equal(echoTool.description, 'Echo arguments from the mock upstream MCP server.');
  assert.equal(echoTool.inputSchema.properties.message.type, 'string');
  assert.deepEqual(echoTool.inputSchema.properties.mode.anyOf, [
    { type: 'string', const: 'brief' },
    { type: 'string', const: 'full' },
  ]);
  assert.equal(echoTool.annotations.readOnlyHint, true);

  const status = await client.callTool({ name: 'proxy.auth_status', arguments: {} });
  assert.deepEqual(status.structuredContent.proxies.map((proxy) => ({
    serverName: proxy.serverName,
    state: proxy.state,
    toolCount: proxy.toolCount,
  })), [{ serverName: 'upstream', state: 'ready', toolCount: 1 }]);

  const signedIn = await client.callTool({
    name: 'proxy.sign_in',
    arguments: { serverName: 'upstream' },
  });
  assert.deepEqual(signedIn.structuredContent.authentication, [{
    serverName: 'upstream',
    ok: true,
    authenticated: true,
    authType: 'none',
    promptedLogin: false,
  }]);
  assert.deepEqual(signedIn.structuredContent.refresh, [
    { serverName: 'upstream', ok: true, toolCount: 1 },
  ]);

  const result = await client.callTool({
    name: 'upstream.echo',
    arguments: { message: 'hello', count: 2, mode: 'full' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'upstream:hello' }]);
  assert.deepEqual(result.structuredContent, {
    received: { message: 'hello', count: 2, mode: 'full' },
    source: 'mock-upstream',
  });

  await fs.writeFile(extraToolFile, 'enabled');
  const refreshed = await client.callTool({ name: 'proxy.refresh_tools', arguments: {} });
  assert.deepEqual(refreshed.structuredContent.refresh, [
    { serverName: 'upstream', ok: true, toolCount: 2 },
  ]);

  const refreshedTools = await client.listTools();
  assert.equal(refreshedTools.tools.some((tool) => tool.name === 'upstream.extra'), true);
  const extra = await client.callTool({ name: 'upstream.extra', arguments: {} });
  assert.deepEqual(extra.content, [{ type: 'text', text: 'extra-ready' }]);
});

test('optional unavailable proxy starts with management tools and status', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-unavailable-'));
  const registryPath = path.join(tempDir, 'registry.json');
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await fs.writeFile(registryPath, JSON.stringify({
    servers: {
      unavailable: {
        kind: 'mcp-proxy',
        proxy: {
          optional: true,
          connection: {
            transport: 'stdio',
            command: path.join(tempDir, 'missing-command'),
          },
        },
      },
    },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/index.js', '--transport', 'stdio', '--registry', registryPath],
    cwd: serverRoot,
    env: process.env,
  });
  const client = new Client({ name: 'unavailable-proxy-test-client', version: '0.1.0' });
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'proxy.auth_status',
    'proxy.refresh_tools',
    'proxy.sign_in',
  ]);
  const status = await client.callTool({ name: 'proxy.auth_status', arguments: {} });
  assert.equal(status.structuredContent.proxies[0].serverName, 'unavailable');
  assert.equal(status.structuredContent.proxies[0].state, 'unavailable');
  assert.equal(status.structuredContent.proxies[0].toolCount, 0);
  assert.notEqual(status.structuredContent.proxies[0].lastError, '');
});