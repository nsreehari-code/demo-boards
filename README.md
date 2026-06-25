# demo-boards

Local demo runner for yaml-flow board examples.

The published frontend artifacts remain in this repo under `docs/`, but the Vite frontend source now lives in the separate `demo-boards-frontend` repo.

## Prerequisites

- Node.js 18+
- npm

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the local backend (MCP server + runtime core) as a background daemon:

```bash
npm i -g pm2   # one-time, required by the daemon (see below)
npm start      # runs detached via PM2 — the terminal can be closed
```

   To run in the foreground instead (logs stream to the terminal):

```bash
npm run start:fg
```

3. Open the hosted frontend in your browser:

- https://nsreehari-code.github.io/demo-boards

## Run as a background daemon (optional)

The backend runs as a background daemon via [PM2](https://pm2.keymetrics.io/) so it
keeps running without an open terminal:

```bash
npm i -g pm2          # one-time, global install
npm start             # start detached (alias for start:daemon)
npm run daemon:logs   # tail combined logs
npm run status:daemon # show process status
npm stop              # stop the daemon (alias for stop:daemon)
```

To auto-start on reboot:

```bash
pm2 save
pm2 startup           # follow the printed instructions (Windows: install pm2-windows-startup)
```

PM2 manages the MCP server plus the shared runtime core, auto-restarts on crash,
and writes logs to `demo-board/logs/pm2-mcp-out.log`, `demo-board/logs/pm2-mcp-error.log`,
`demo-board/logs/pm2-runtime-out.log`, and `demo-board/logs/pm2-runtime-error.log`.

## Frontend Source

- The frontend is hosted via GitHub Pages at https://nsreehari-code.github.io/demo-boards.
- Frontend source, build, and Pages deployment live in the separate `demo-boards-frontend` repo.

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the backend detached via PM2 (alias for `start:daemon`; terminal can be closed) |
| `npm stop` | Stop the PM2-managed backend (alias for `stop:daemon`) |
| `npm run start:fg` | Start the MCP server and the shared runtime core locally in the foreground (frontend is hosted at https://nsreehari-code.github.io/demo-boards) |
| `npm run start:daemon` | Start the backend detached via PM2 (terminal can be closed) |
| `npm run stop:daemon` | Stop the PM2-managed backend |
| `npm run status:daemon` | Show PM2 process status |
| `npm run daemon:logs` | Tail the PM2-managed backend logs |
| `npm run mcp:install` | Install dependencies for `mcp-server/` |
| `npm run mcp:dry-run` | Validate the WorkIQ MCP manifest without starting transport |
| `npm run setup:check:copilot-only` | Smoke-check both Copilot wrappers with a simple query (`what is two plus two`) |
| `npm run setup:check:workiq-only` | Smoke-check direct WorkIQ CLI invocation with a simple query (`what is two plus two`) |
| `npm run setup:check:copilot-workiq` | Smoke-check both Copilot wrappers and run a direct WorkIQ CLI query (`what is two plus two`) without starting MCP |
| `npm run mcp:start` | Start the hosted MCP server for the demo-boards WorkIQ manifest at `http://127.0.0.1:7801/mcp` |
| `npm run clean` | Wipe runtime state in `demo-board/boards/live/` (preserves cards) |
| `npm run stop:fg` | Kill foreground processes on ports 7799 and 7801 |

## Directory structure

```
demo-boards/
  demo-board/             <- active demo board
    boards/
      live/
        cards/            <- source cards (git-tracked)
        gandalf-cards/    <- source gandalf cards (git-tracked)
        board-default/    <- runtime state (gitignored)
    server/
      board-server.js
  docs/                   <- published frontend artifacts
  scripts/
    start-server.cjs      <- legacy combined runner pending frontend-split rewiring
  mcp-server/             <- manifest-driven MCP server scaffold
```

## Environment variables (auto-set by the start scripts)

- `BOARD_LIVE_CARDS_CLI_JS` → local `yaml-flow` CLI path
- `DEMO_STEP_MACHINE_CLI_PATH` → local `yaml-flow` step-machine CLI path

## Notes

- Cards live in `demo-board/boards/live/cards/` and are the single source of truth — no tmp-copy step.
- `demo-board/boards/live/board-default/` is gitignored (runtime state).
- `npm run clean` preserves `live/cards/` and `live/gandalf-cards/`.
- `docs/` in this repo is the checked-in published frontend output; it is intentionally retained here.
- `mcp-server/` is intended to be the shared MCP runtime for `demo-boards` tools and future repo-backed tool manifests.
- `demo-board/boards/live/cards/card-my-identity.json` now uses the generic `mcp` source kind against `demo-boards.workiq.json`.
- See `demo-board/projection-taxonomy.md` for the concrete board-as-case / live-cards-as-projections taxonomy, including Gandalf ingest and truth-alignment guidance.
