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
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].name, 'upstream.echo');
  assert.equal(listed.tools[0].title, 'Upstream Echo');
  assert.equal(listed.tools[0].description, 'Echo arguments from the mock upstream MCP server.');
  assert.equal(listed.tools[0].inputSchema.properties.message.type, 'string');
  assert.deepEqual(listed.tools[0].inputSchema.properties.mode.anyOf, [
    { type: 'string', const: 'brief' },
    { type: 'string', const: 'full' },
  ]);
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);

  const result = await client.callTool({
    name: 'upstream.echo',
    arguments: { message: 'hello', count: 2, mode: 'full' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'upstream:hello' }]);
  assert.deepEqual(result.structuredContent, {
    received: { message: 'hello', count: 2, mode: 'full' },
    source: 'mock-upstream',
  });
});