'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCOPE_GLOBAL = 'global';
const SCOPE_PREFIXES = ['board/', 'user/', 'app/'];
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function validateScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) {
    const err = new Error('scope is required');
    err.code = 'lore_scope_invalid';
    throw err;
  }
  if (scope === SCOPE_GLOBAL) return { kind: 'global', id: null };
  const prefix = SCOPE_PREFIXES.find((candidate) => scope.startsWith(candidate));
  if (!prefix) {
    const err = new Error(`scope must be "global", "board/<id>", "user/<id>", or "app/<id>" (got "${scope}")`);
    err.code = 'lore_scope_invalid';
    throw err;
  }
  const id = scope.slice(prefix.length);
  if (!SEGMENT_RE.test(id)) {
    const err = new Error(`scope id segment "${id}" is invalid (allowed: a-z 0-9 . _ -)`);
    err.code = 'lore_scope_invalid';
    throw err;
  }
  return { kind: prefix.slice(0, -1), id };
}

function normalizeKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    const err = new Error('key is required');
    err.code = 'lore_key_required';
    throw err;
  }
  return key.trim();
}

function resolveScopeFile(rootDir, scope) {
  const parsed = validateScope(scope);
  if (parsed.kind === 'global') return path.join(rootDir, 'global', 'kb.json');
  if (parsed.kind === 'board') return path.join(rootDir, 'boards', parsed.id, 'kb.json');
  if (parsed.kind === 'app') return path.join(rootDir, 'apps', parsed.id, 'kb.json');
  return path.join(rootDir, 'users', parsed.id, 'kb.json');
}

function ensureShape(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) return { entries: [] };
  if (!Array.isArray(db.entries)) return { ...db, entries: [] };
  return db;
}

function loadScope(rootDir, scope) {
  const file = resolveScopeFile(rootDir, scope);
  if (!fs.existsSync(file)) return { file, db: { entries: [] } };
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!raw) return { file, db: { entries: [] } };
  return { file, db: ensureShape(JSON.parse(raw)) };
}

function saveScope(file, db) {
  const next = ensureShape(db);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tempFile, file);
  return file;
}

function appendValue(previousValue, nextValue) {
  if (typeof previousValue === 'string' && typeof nextValue === 'string') {
    return previousValue ? `${previousValue}\n${nextValue}` : nextValue;
  }
  if (Array.isArray(previousValue) && Array.isArray(nextValue)) return [...previousValue, ...nextValue];
  if (Array.isArray(previousValue)) return [...previousValue, nextValue];
  if (Array.isArray(nextValue)) return [previousValue, ...nextValue];
  return [previousValue, nextValue];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function get(rootDir, scope, key) {
  const normalizedKey = normalizeKey(key);
  const { db } = loadScope(rootDir, scope);
  return db.entries.find((entry) => entry.key === normalizedKey) || null;
}

function getAll(rootDir, scope, options = {}) {
  const { db } = loadScope(rootDir, scope);
  let entries = db.entries;
  if (options.includeDeprecated !== true) {
    entries = entries.filter((entry) => entry.deprecated !== true);
  }
  if (typeof options.keyPrefix === 'string' && options.keyPrefix.length > 0) {
    entries = entries.filter((entry) => typeof entry.key === 'string' && entry.key.startsWith(options.keyPrefix));
  }
  return [...entries];
}

function set(rootDir, scope, key, value) {
  const normalizedKey = normalizeKey(key);
  if (typeof value === 'undefined') {
    const err = new Error('value is required');
    err.code = 'lore_value_required';
    throw err;
  }
  const { file, db } = loadScope(rootDir, scope);
  const now = new Date().toISOString();
  const existing = db.entries.find((entry) => entry.key === normalizedKey);
  let entry;
  let created;
  if (existing) {
    existing.value = value;
    existing.deprecated = false;
    existing.updatedAt = now;
    entry = clone(existing);
    created = false;
  } else {
    entry = { key: normalizedKey, value, deprecated: false, createdAt: now, updatedAt: now };
    db.entries.push(entry);
    created = true;
  }
  saveScope(file, db);
  return { created, entry: clone(entry) };
}

function append(rootDir, scope, key, value) {
  const normalizedKey = normalizeKey(key);
  if (typeof value === 'undefined') {
    const err = new Error('value is required');
    err.code = 'lore_value_required';
    throw err;
  }
  const { file, db } = loadScope(rootDir, scope);
  const now = new Date().toISOString();
  const existing = db.entries.find((entry) => entry.key === normalizedKey);
  let entry;
  let created;
  if (existing) {
    existing.value = appendValue(existing.value, value);
    existing.deprecated = false;
    existing.updatedAt = now;
    entry = clone(existing);
    created = false;
  } else {
    entry = { key: normalizedKey, value, deprecated: false, createdAt: now, updatedAt: now };
    db.entries.push(entry);
    created = true;
  }
  saveScope(file, db);
  return { created, entry: clone(entry) };
}

function deprecate(rootDir, scope, key) {
  const normalizedKey = normalizeKey(key);
  const { file, db } = loadScope(rootDir, scope);
  const existing = db.entries.find((entry) => entry.key === normalizedKey);
  if (!existing) {
    const err = new Error(`Lore entry "${normalizedKey}" not found in scope "${scope}"`);
    err.code = 'lore_not_found';
    throw err;
  }
  existing.deprecated = true;
  existing.updatedAt = new Date().toISOString();
  saveScope(file, db);
  return { entry: clone(existing) };
}

function remove(rootDir, scope, key) {
  const normalizedKey = normalizeKey(key);
  const { file, db } = loadScope(rootDir, scope);
  const index = db.entries.findIndex((entry) => entry.key === normalizedKey);
  if (index === -1) {
    const err = new Error(`Lore entry "${normalizedKey}" not found in scope "${scope}"`);
    err.code = 'lore_not_found';
    throw err;
  }
  const [removed] = db.entries.splice(index, 1);
  saveScope(file, db);
  return { entry: clone(removed) };
}

function listScopes(rootDir, options = {}) {
  const scopes = [];
  if (fs.existsSync(path.join(rootDir, 'global', 'kb.json'))) {
    scopes.push('global');
  }
  for (const [dirName, scopePrefix] of [['boards', 'board'], ['users', 'user'], ['apps', 'app']]) {
    const baseDir = path.join(rootDir, dirName);
    if (!fs.existsSync(baseDir)) continue;
    for (const id of fs.readdirSync(baseDir)) {
      if (fs.existsSync(path.join(baseDir, id, 'kb.json'))) {
        scopes.push(`${scopePrefix}/${id}`);
      }
    }
  }
  if (typeof options.prefix === 'string' && options.prefix.length > 0) {
    return scopes.filter((scope) => scope.startsWith(options.prefix));
  }
  return scopes;
}

module.exports = {
  validateScope,
  resolveScopeFile,
  get,
  getAll,
  set,
  append,
  deprecate,
  remove,
  listScopes,
};