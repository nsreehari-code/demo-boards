#!/usr/bin/env node

import http from 'node:http';

function readOption(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return String(process.argv[index + 1] || '').trim() || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(url) {
  return await new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : null;
          resolve(response.statusCode === 200 && payload?.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function main() {
  const url = readOption('--url', 'http://127.0.0.1:7799/healthz');
  const timeoutMs = Number.parseInt(readOption('--timeout-ms', '30000'), 10) || 30000;
  const intervalMs = Number.parseInt(readOption('--interval-ms', '500'), 10) || 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (await probe(url)) {
      process.stdout.write(`[wait-for-healthz] ready ${url}\n`);
      return;
    }
    await sleep(intervalMs);
  }

  process.stderr.write(`[wait-for-healthz] timed out waiting for ${url}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`[wait-for-healthz] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});