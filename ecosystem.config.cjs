// PM2 process definition for running the demo-boards backend as a background
// daemon (MCP server on 7801 + hosted runtime/controlface on 7799).
//
// Usage:
//   npm i -g pm2                 # one-time, global install
//   npm run daemon               # start detached (terminal can be closed)
//   npm run daemon:logs          # tail logs
//   npm run daemon:stop          # stop the daemon
//   pm2 save && pm2-startup      # (optional) auto-start on reboot
//
// This wraps scripts/start-server.cjs, which already orchestrates the MCP
// server and hosted runtime and exits if either child dies — PM2 then
// auto-restarts the whole supervisor.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'demo-boards',
      script: 'scripts/start-server.cjs',
      args: 'demo-board --all',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 3000,
      out_file: path.join(__dirname, 'demo-board', 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'demo-board', 'logs', 'pm2-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
