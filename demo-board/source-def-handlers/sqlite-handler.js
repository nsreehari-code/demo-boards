#!/usr/bin/env node

/**
 * sqlite-handler.js — Query a SQLite database via scripts/sqlite/query.cjs.
 *
 * DB filename is resolved relative to scripts/sqlite/.retain/.
 * Supports SELECT (returns row array) and exec mode for INSERT/UPDATE/DELETE.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const executorDir = context?.executorDir || process.cwd();

  const cfg = typeof sourceDef.sqlite === 'object' ? sourceDef.sqlite : {};
  if (!cfg.db || !cfg.query) {
    return { result: 'failure', data: { error: 'sqlite: db and query are required' }, error: 'missing db/query' };
  }

  const queryScript = path.join(executorDir, 'scripts', 'sqlite', 'query.cjs');
  const cliArgs = ['--db', cfg.db, '--sql', cfg.query];
  if (cfg.params) {
    const resolvedParams = Array.isArray(cfg.params)
      ? cfg.params.map(p => typeof p === 'string' ? interpolate(p, sourceDef._projections || {}) : p)
      : [];
    cliArgs.push('--params', JSON.stringify(resolvedParams));
  }
  if (cfg.mode === 'exec') {
    cliArgs.push('--mode', 'exec');
  }

  try {
    const raw = execFileSync(process.execPath, [queryScript, ...cliArgs], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      cwd: executorDir,
    });
    const resultValue = raw.trim() ? JSON.parse(raw) : [];
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
    return { result: 'failure', data: { error: `sqlite query failed: ${msg}` }, error: msg };
  }
}
