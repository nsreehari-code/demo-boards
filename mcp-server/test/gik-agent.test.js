import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleGikAgentTool } from '../src/handlers/gik-agent.js';

test('describe manifest uses Foundry-compatible function parameters', () => {
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../manifests/gik-agent-authoring.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    Object.hasOwn(manifest.tools[0].inputSchema.properties.capabilities, 'uniqueItems'),
    false,
  );
});

test('describe returns multiple capability contracts from the provisioned catalog', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gik-capabilities-'));
  const catalogPath = path.join(directory, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    catalog: {
      'primitive:markdown': { for: ['Narrative documents'] },
      'semantic:narrative': { for: ['Structured narratives'] },
    },
    details: {
      'primitive:markdown': { props: { markdown: { type: 'string' } } },
      'semantic:narrative': { slots: ['sections'] },
    },
  }));

  try {
    const result = await handleGikAgentTool({
      kind: 'multiple-capabilities',
      capabilities: ['primitive:markdown', 'semantic:narrative'],
    }, {
      name: 'describe',
      config: { catalogPath },
    });

    assert.deepEqual(Object.keys(result.structuredContent.capabilities), [
      'primitive:markdown',
      'semantic:narrative',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('describe does not preserve the removed singular capability kind', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gik-capabilities-'));
  const catalogPath = path.join(directory, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    catalog: { 'primitive:markdown': { for: ['Narrative documents'] } },
    details: { 'primitive:markdown': { props: {} } },
  }));

  try {
    await assert.rejects(
      handleGikAgentTool({
        kind: 'capability',
        capabilities: ['primitive:markdown'],
      }, {
        name: 'describe',
        config: { catalogPath },
      }),
      /Unsupported describe kind 'capability'/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
