#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultTargetDir = path.resolve(scriptDirectory, '..', '.copilot-workspace');

function parseArgs(argv) {
  const options = {
    plan: process.env.COPILOT_PROVISIONING_PLAN,
    targetDir: defaultTargetDir,
    dryRun: false,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') options.plan = argv[index += 1];
    else if (argument === '--target-dir') options.targetDir = path.resolve(process.cwd(), argv[index += 1]);
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: provision-copilot-agents.mjs --plan <plan.json> [options]\n\nOptions:\n  --target-dir <path>  Workspace directory\n  --dry-run            List planned files without writing\n  --force              Overwrite changed managed files\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.plan) throw new Error('--plan or COPILOT_PROVISIONING_PLAN is required');
  return options;
}

function readPlan(filePath) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) {
    throw new Error('Provisioning plan must contain a non-empty files array');
  }
  const paths = new Set();
  for (const file of plan.files) {
    if (!file || typeof file.path !== 'string' || !file.path.trim() || path.isAbsolute(file.path)) {
      throw new Error('Each provisioning file requires a non-empty relative path');
    }
    const normalized = path.normalize(file.path);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Provisioning file escapes the workspace: '${file.path}'`);
    }
    if (typeof file.content !== 'string') throw new Error(`Provisioning file '${file.path}' requires string content`);
    if (paths.has(normalized)) throw new Error(`Duplicate provisioning path '${file.path}'`);
    paths.add(normalized);
  }
  return plan;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function initializeRepository(targetDir) {
  if (fs.existsSync(path.join(targetDir, '.git'))) return;
  execFileSync('git', ['init'], { cwd: targetDir, stdio: 'ignore' });
}

function writeIfChanged(filePath, content) {
  ensureDirectory(path.dirname(filePath));
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

const options = parseArgs(process.argv.slice(2));
const plan = readPlan(options.plan);

if (options.dryRun) {
  console.log(`Dry run: would provision ${plan.files.length} files under ${options.targetDir}`);
  for (const file of plan.files) console.log(path.join(options.targetDir, file.path));
  process.exit(0);
}

ensureDirectory(options.targetDir);
initializeRepository(options.targetDir);
for (const file of plan.files) {
  const filePath = path.join(options.targetDir, file.path);
  if (fs.existsSync(filePath) && !options.force) {
    if (fs.readFileSync(filePath, 'utf8') === file.content) continue;
    console.log(`Preserving existing file (use --force to overwrite): ${filePath}`);
    continue;
  }
  const changed = writeIfChanged(filePath, file.content);
  console.log(`${changed ? 'Created/updated' : 'Unchanged'}: ${filePath}`);
}
