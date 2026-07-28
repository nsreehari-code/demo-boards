#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'mock-upstream',
  version: '1.0.0',
});

server.registerTool(
  'upstream.echo',
  {
    title: 'Upstream Echo',
    description: 'Echo arguments from the mock upstream MCP server.',
    inputSchema: {
      message: z.string().describe('Message to echo.'),
      count: z.int().optional(),
      mode: z.union([z.literal('brief'), z.literal('full')]).optional(),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (args) => ({
    content: [
      {
        type: 'text',
        text: `upstream:${args.message}`,
      },
    ],
    structuredContent: {
      received: args,
      source: 'mock-upstream',
    },
  }),
);

if (process.env.MOCK_UPSTREAM_EXTRA_TOOL_FILE && fs.existsSync(process.env.MOCK_UPSTREAM_EXTRA_TOOL_FILE)) {
  server.registerTool(
    'upstream.extra',
    {
      title: 'Upstream Extra',
      description: 'A tool added after proxy startup.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'extra-ready' }] }),
  );
}

await server.connect(new StdioServerTransport());