#!/usr/bin/env node
// Build the Vite app directly into <repo>/docs, then commit and push.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viteRoot = resolve(here, '..');
const repoRoot = resolve(viteRoot, '..', '..', '..');
const docsDir = resolve(repoRoot, 'docs');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`\n[deploy] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

const env = {
  ...process.env,
  VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/demo-boards/',
  VITE_SERVER_ORIGIN: process.env.VITE_SERVER_ORIGIN || 'http://localhost:7799',
};

console.log('[deploy] building vite app...');
run(process.execPath, [resolve(viteRoot, 'scripts', 'build.mjs')], { cwd: viteRoot, env });

writeFileSync(resolve(docsDir, '.nojekyll'), '');

if (process.env.DEPLOY_NO_GIT === '1') {
  console.log('[deploy] DEPLOY_NO_GIT=1 set; skipping git commit/push');
  process.exit(0);
}

const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', 'docs'], { encoding: 'utf8' });
if (!status.stdout.trim()) {
  console.log('[deploy] no changes in docs/; nothing to commit');
  process.exit(0);
}

console.log('[deploy] committing & pushing docs/');
run('git', ['-C', repoRoot, 'add', 'docs']);
const msg = process.env.DEPLOY_MSG || `deploy: refresh docs/ ${new Date().toISOString()}`;
run('git', ['-C', repoRoot, 'commit', '-m', msg]);
run('git', ['-C', repoRoot, 'push', 'origin', 'HEAD']);
console.log('[deploy] done. site: https://nsreehari-code.github.io/demo-boards/');
