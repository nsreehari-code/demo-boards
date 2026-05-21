import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function asPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function toMcpResult(envelope) {
  return {
    content: [{ type: 'text', text: asPrettyJson(envelope) }],
    structuredContent: envelope,
  };
}

function success(operation, params, data) {
  return { ok: true, operation, params: params || {}, data };
}

function failure(operation, params, message, code = 'lore_error') {
  return { ok: false, operation, params: params || {}, error: { code, message } };
}

function resolveRootDir(tool) {
  const configured = tool?.config?.rootPath;
  if (configured && typeof configured === 'string') {
    const manifestDir = path.dirname(tool.manifestPath);
    const resolved = path.resolve(manifestDir, configured);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }
  const envRoot = process.env.LORE_ROOT_DIR;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot);
  }
  throw new Error('lore root directory is not configured (set tool.config.rootPath or LORE_ROOT_DIR)');
}

function loadStore(tool) {
  const repoRoot = resolveRootDir(tool);
  const storePath = path.join(repoRoot, 'lib', 'lore-store.cjs');
  delete require.cache[require.resolve(storePath)];
  return { store: require(storePath), rootDir: repoRoot };
}

function getAction(toolName) {
  return String(toolName || '').replace(/^lore\./, '');
}

export async function handleLoreTool(args, tool) {
  const operation = tool.name;
  const action = getAction(tool.name);
  const params = { scope: args?.scope || null, key: args?.key || null };

  try {
    const { store, rootDir } = loadStore(tool);

    switch (action) {
      case 'get': {
        const entry = store.get(rootDir, args.scope, args.key);
        return toMcpResult(success(operation, params, { scope: args.scope, key: args.key, entry }));
      }
      case 'get_all': {
        const entries = store.getAll(rootDir, args.scope, {
          keyPrefix: args?.keyPrefix,
          includeDeprecated: args?.includeDeprecated === true,
        });
        return toMcpResult(success(operation, { scope: args.scope, keyPrefix: args?.keyPrefix || null, includeDeprecated: args?.includeDeprecated === true }, {
          scope: args.scope,
          count: entries.length,
          entries,
        }));
      }
      case 'list_scopes': {
        const scopes = store.listScopes(rootDir, { prefix: args?.prefix });
        return toMcpResult(success(operation, { prefix: args?.prefix || null }, { scopes }));
      }
      case 'set': {
        const result = store.set(rootDir, args.scope, args.key, args.value);
        return toMcpResult(success(operation, params, { scope: args.scope, key: args.key, ...result }));
      }
      case 'append': {
        const result = store.append(rootDir, args.scope, args.key, args.value);
        return toMcpResult(success(operation, params, { scope: args.scope, key: args.key, ...result }));
      }
      case 'deprecate': {
        const result = store.deprecate(rootDir, args.scope, args.key);
        return toMcpResult(success(operation, params, { scope: args.scope, key: args.key, ...result }));
      }
      default:
        throw new Error(`Unsupported lore tool: ${tool.name}`);
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'lore_error';
    return toMcpResult(failure(operation, params, error.message, code));
  }
}
