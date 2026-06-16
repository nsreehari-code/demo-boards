import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function resolveWorkiqCliPath() {
  const candidate = path.join(
    process.env.APPDATA || os.homedir(),
    'npm', 'node_modules', '@microsoft', 'workiq', 'bin', 'workiq.js'
  );

  if (!fs.existsSync(candidate)) {
    throw new Error(`WorkIQ CLI not found at: ${candidate}`);
  }

  return candidate;
}

function runWorkiq(query, timeoutMs) {
  const workiqJs = resolveWorkiqCliPath();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(process.execPath, [workiqJs, 'ask', '-q', query], {
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`workiq timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(stderr || `workiq exited ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function askWorkiq(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : 1_200_000;

  if (!query) {
    throw new Error('workiq.ask requires a non-empty query');
  }

  const response = await runWorkiq(query, timeoutMs);
  return {
    content: [
      {
        type: 'text',
        text: response,
      },
    ],
    structuredContent: {
      response,
    },
  };
}
