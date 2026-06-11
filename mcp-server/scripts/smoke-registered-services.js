#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest-loader.js';
import { resolveHandler } from '../src/handler-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpServerRoot = path.resolve(__dirname, '..');
const registryPath = path.join(mcpServerRoot, 'registry.json');
const manifestsDir = path.join(mcpServerRoot, 'manifests');

function resolveManifestPath(ref) {
  if (path.isAbsolute(ref)) return ref;
  if (ref.startsWith('.') || ref.includes('/') || ref.includes('\\')) {
    return path.resolve(mcpServerRoot, ref);
  }
  return path.resolve(manifestsDir, ref);
}

function readRegistry() {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Registry ${registryPath} must contain an object`);
  }
  const servers = parsed.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`Registry ${registryPath} must contain a servers object`);
  }
  return servers;
}

function parseDisabledHandlers() {
  const raw = process.env.DISABLE_HANDLERS;
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function main() {
  const servers = readRegistry();
  const disabledHandlers = parseDisabledHandlers();
  const seenToolNames = new Map();
  const summaries = [];

  for (const [serverName, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Registry server ${serverName} must be an object`);
    }
    if (entry.disabled === true) {
      console.log(`[mcp:test] skipping disabled registry service ${serverName}`);
      continue;
    }
    if (disabledHandlers.has(serverName.toLowerCase())) {
      console.log(`[mcp:test] skipping registry service ${serverName} (DISABLE_HANDLERS)`);
      continue;
    }
    if (typeof entry.manifest !== 'string' || !entry.manifest.trim()) {
      throw new Error(`Registry server ${serverName} is missing a manifest string`);
    }

    const manifestPath = resolveManifestPath(entry.manifest.trim());
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Registry server ${serverName} manifest not found: ${manifestPath}`);
    }

    const loaded = loadManifest(manifestPath);
    const toolNames = [];

    for (const tool of loaded.manifest.tools) {
      const prior = seenToolNames.get(tool.name);
      if (prior) {
        throw new Error(
          `Duplicate tool name ${tool.name} across registry services ${prior.serverName} and ${serverName}`
        );
      }
      seenToolNames.set(tool.name, { serverName, manifestPath });

      resolveHandler(tool.handler);
      toolNames.push(`${tool.name} -> ${tool.handler}`);
    }

    summaries.push({
      serverName,
      manifestPath,
      toolCount: toolNames.length,
      toolNames,
    });
  }

  console.log(`[mcp:test] validated ${summaries.length} registry services and ${seenToolNames.size} tools`);
  for (const summary of summaries) {
    console.log(`- ${summary.serverName}: ${summary.toolCount} tools`);
    console.log(`  manifest: ${path.relative(mcpServerRoot, summary.manifestPath).replace(/\\/g, '/')}`);
    for (const toolName of summary.toolNames) {
      console.log(`  ${toolName}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[mcp:test] ${String(error?.message || error)}`);
  process.exit(1);
}