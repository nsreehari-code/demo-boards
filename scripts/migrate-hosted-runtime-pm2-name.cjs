const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LEGACY_APP_NAME = 'demo-boards-embedded';
const CURRENT_APP_NAME = 'demo-boards-runtime';
const PM2_CLI_PATH = path.resolve(__dirname, '..', 'node_modules', 'pm2', 'bin', 'pm2');

function runPm2(args, { inherit = false } = {}) {
  return spawnSync(process.execPath, [PM2_CLI_PATH, ...args], {
    encoding: 'utf8',
    shell: false,
    stdio: inherit ? 'inherit' : 'pipe',
  });
}

function extractJsonArray(rawText) {
  const text = String(rawText || '');
  const objectArrayStart = text.indexOf('[{');
  const emptyArrayStart = text.indexOf('[]');
  const start = objectArrayStart >= 0 ? objectArrayStart : emptyArrayStart;
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error('pm2 jlist did not return a JSON array');
  }
  return text.slice(start, end + 1);
}

function listPm2ProcessNames() {
  const result = runPm2(['jlist']);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'pm2 jlist failed').trim());
  }
  const parsed = JSON.parse(extractJsonArray(result.stdout));
  return new Set(
    Array.isArray(parsed)
      ? parsed
        .map((entry) => (entry && typeof entry.name === 'string' ? entry.name.trim() : ''))
        .filter(Boolean)
      : [],
  );
}

function main() {
  const names = listPm2ProcessNames();
  const staleAppNames = [LEGACY_APP_NAME, CURRENT_APP_NAME].filter((name) => names.has(name));
  if (staleAppNames.length === 0) {
    return;
  }

  for (const appName of staleAppNames) {
    process.stdout.write(`[pm2:runtime:migrate] deleting app '${appName}' before using '${CURRENT_APP_NAME}'\n`);
    const result = runPm2(['delete', appName], { inherit: true });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[pm2:runtime:migrate] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}