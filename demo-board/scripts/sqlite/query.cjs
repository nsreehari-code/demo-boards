#!/usr/bin/env node

/**
 * scripts/sqlite/query.cjs — SQLite query runner for demo-task-executor.
 *
 * Usage:
 *   node query.cjs --db <path> --sql <query> [--params <json-array>] [--mode query|exec]
 *
 * Modes:
 *   query (default) — SELECT; outputs JSON array of row objects to stdout.
 *   exec            — INSERT/UPDATE/DELETE; outputs { changes, lastInsertRowid }.
 */

const Database = require('better-sqlite3');
const path     = require('path');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null;
}

const dbArg      = getArg('--db');
const sql        = getArg('--sql');
const paramsJson = getArg('--params');
const mode       = getArg('--mode') || 'query';

if (!dbArg || !sql) {
  console.error('Usage: query.cjs --db <name> --sql <query> [--params <json>] [--mode query|exec]');
  process.exit(1);
}

// Resolve db: bare filename -> .retain/<name>, absolute/relative path passed through
const dbPath = path.isAbsolute(dbArg) || dbArg.includes(path.sep) || dbArg.includes('/')
  ? path.resolve(dbArg)
  : path.join(__dirname, '.retain', dbArg);

let params = [];
if (paramsJson) {
  try { params = JSON.parse(paramsJson); }
  catch { console.error('Invalid --params JSON'); process.exit(1); }
}

try {
  const db = new Database(dbPath, { readonly: mode === 'query' });
  if (mode === 'exec') {
    const info = db.prepare(sql).run(...params);
    console.log(JSON.stringify({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }));
  } else {
    const rows = db.prepare(sql).all(...params);
    console.log(JSON.stringify(rows));
  }
  db.close();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
