import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function toMcpResult(envelope) {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

function resolveApp(tool) {
  const config = tool?.config && typeof tool.config === 'object' ? tool.config : {};
  const manifestDir = path.dirname(tool.manifestPath);
  const rootDir = path.resolve(manifestDir, config.rootPath || '.');
  const corePath = path.join(rootDir, 'lib', 'feeds-core.cjs');
  const { createFeedsApp } = require(corePath);
  return createFeedsApp({
    dbPath: path.join(rootDir, 'DB', 'feeds.db'),
    seedPath: path.join(rootDir, 'DB', 'seed-sources.json'),
  });
}

export async function handleFeedsTool(args, tool) {
  const operation = tool.name;
  try {
    const app = resolveApp(tool);
    let data;
    switch (operation) {
      case 'feeds.list_sources':
        data = app.listSources(args);
        break;
      case 'feeds.read_items':
        data = app.readItems(args);
        break;
      case 'feeds.search_items':
        data = app.searchItems(args);
        break;
      case 'feeds.get_item':
        data = app.getItem(args);
        break;
      case 'feeds_control.refresh_sources':
        data = await app.refreshSources(args);
        break;
      case 'feeds_control.add_source':
        data = await app.addSource(args);
        break;
      case 'feeds_control.delete_source':
        data = app.deleteSource(args);
        break;
      default:
        throw new Error(`Unsupported feeds tool: ${operation}`);
    }
    return toMcpResult({ ok: true, operation, data });
  } catch (error) {
    return toMcpResult({
      ok: false,
      operation,
      error: { code: 'feeds_error', message: String(error?.message || error) },
    });
  }
}