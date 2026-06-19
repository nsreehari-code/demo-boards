// PM2 process definitions for running demo-boards backend services directly.
//
// Services:
// - MCP server on 7801
// - hosted runtime embedded host on 7799 (controlface HTTP + queue-runner lanes
//   in a single process; replaces the former two-process controlface +
//   queue-runner split)
//
// Usage:
//   npm i -g pm2                 # one-time, global install
//   npm run daemon               # start detached (terminal can be closed)
//   npm run daemon:logs          # tail logs
//   npm run daemon:stop          # stop the daemon
//   pm2 save && pm2-startup      # (optional) auto-start on reboot
const path = require('node:path');

const ROOT = __dirname;
const RUNTIME_DIR = path.join(ROOT, 'demo-board', 'server', 'hosted-board-runtime');

module.exports = {
  apps: [
    {
      name: 'demo-boards-mcp',
      script: path.join(ROOT, 'mcp-server', 'src', 'index.js'),
      args: '--transport streamable-http',
      cwd: path.join(ROOT, 'mcp-server'),
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 3000,
      out_file: path.join(ROOT, 'demo-board', 'logs', 'pm2-mcp-out.log'),
      error_file: path.join(ROOT, 'demo-board', 'logs', 'pm2-mcp-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'demo-boards-embedded',
      script: path.join(RUNTIME_DIR, 'embedded', 'index.js'),
      args: '--config ./hosted-board-runtime.localfs.config.json',
      cwd: RUNTIME_DIR,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 3000,
      out_file: path.join(ROOT, 'demo-board', 'logs', 'pm2-embedded-out.log'),
      error_file: path.join(ROOT, 'demo-board', 'logs', 'pm2-embedded-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
