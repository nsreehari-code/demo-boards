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

const EULA_URL = 'https://github.com/microsoft/work-iq-mcp';

// The `workiq ask` CLI command requires an interactive TTY on stdin and produces
// no output when spawned by a background process (e.g. PM2-hosted MCP server).
// Instead we drive WorkIQ's own MCP stdio server (`workiq mcp`), which is the
// purpose-built headless interface for programmatic/agent access.
function runWorkiq(query, timeoutMs) {
  const workiqJs = resolveWorkiqCliPath();

  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    let nextId = 0;
    const pending = new Map();

    const child = spawn(process.execPath, [workiqJs, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timeoutId = setTimeout(() => finish(new Error(`workiq timed out after ${timeoutMs}ms`)), timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    }

    function request(method, params) {
      const id = ++nextId;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    function notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }

    function callTool(name, args) {
      return request('tools/call', { name, arguments: args }).then(result => {
        const text = (result?.content || [])
          .filter(part => part?.type === 'text')
          .map(part => part.text)
          .join('\n')
          .trim();
        if (result?.isError) {
          throw new Error(text || `workiq tool '${name}' returned an error`);
        }
        return text;
      });
    }

    function handleMessage(msg) {
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    }

    child.stdout.on('data', chunk => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handleMessage(msg);
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', err => finish(err));

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(stderr.trim() || `workiq mcp server exited ${code}`));
    });

    (async () => {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'demo-boards-mcp', version: '1.0.0' },
      });
      notify('notifications/initialized', {});
      // Idempotent; ensures access even on a freshly-provisioned machine.
      try {
        await callTool('accept_eula', { eulaUrl: EULA_URL });
      } catch {
        // Ignore: EULA may already be accepted on disk.
      }
      const answer = await callTool('ask_work_iq', { question: query });
      finish(null, answer);
    })().catch(err => finish(err));
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
