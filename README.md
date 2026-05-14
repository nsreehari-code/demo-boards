# demo-boards

Local demo runner for yaml-flow board examples.

## Prerequisites

- Node.js 18+
- npm

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start backend + frontend together:

```bash
npm start
```

3. Open in browser:

- http://127.0.0.1:8000/

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start backend (port 7813) + frontend (port 8000) together |
| `npm run backend` | Start backend API server only at `http://127.0.0.1:7813` |
| `npm run frontend` | Serve `demo-board/` as static files at `http://127.0.0.1:8000` |
| `npm run mcp:install` | Install dependencies for `mcp-server/` |
| `npm run mcp:dry-run` | Validate the WorkIQ MCP manifest without starting transport |
| `npm run mcp:start` | Start the hosted MCP server for the demo-boards WorkIQ manifest at `http://127.0.0.1:7823/mcp` |
| `npm run clean` | Wipe runtime state in `demo-board/live/` (preserves cards) |
| `npm run stop` | Kill processes on ports 7813, 7823 and 8000 |

## Directory structure

```
demo-boards/
  default-board/          <- template board (used by copy-example-board)
  demo-board/             <- active demo board
    live/
      cards/              <- source cards (git-tracked)
      gandalf-cards/      <- source gandalf cards (git-tracked)
      board-default/      <- runtime state (gitignored)
    demo-server.js
    demo-server-config.json
    demo-task-executor.js
    demo-chat-handler.js
    index.html
  scripts/
    start-server.cjs      <- starts backend/frontend with env-var wiring
    copy-example-board.cjs <- copies default-board to create a new board
  mcp-server/             <- manifest-driven MCP server scaffold
```

## Environment variables (auto-set by `npm start`)

- `BOARD_LIVE_CARDS_CLI_JS` → local `yaml-flow` CLI path
- `DEMO_STEP_MACHINE_CLI_PATH` → local `yaml-flow` step-machine CLI path

## Notes

- Cards live in `demo-board/live/cards/` and are the single source of truth — no tmp-copy step.
- `demo-board/live/board-default/` is gitignored (runtime state).
- `npm run clean` preserves `live/cards/` and `live/gandalf-cards/`.
- `mcp-server/` is intended to be the shared MCP runtime for `demo-boards` tools and future repo-backed tool manifests.
- `demo-board/live/cards/card-my-identity.json` now uses the generic `mcp` source kind against `demo-boards.workiq.json`.
- See `demo-board/projection-taxonomy.md` for the concrete board-as-case / live-cards-as-projections taxonomy, including Gandalf ingest and truth-alignment guidance.
