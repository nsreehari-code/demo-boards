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

2. Serve the published frontend artifacts locally:

```bash
npm run frontend
```

3. Open in browser:

- http://127.0.0.1:8000/

## Frontend Source

- Published frontend artifacts are kept in `docs/` in this repo.
- Frontend source, build, and Pages deployment now live in the separate `demo-boards-frontend` repo.
- The root `npm start` flow in this repo still needs rewiring after the frontend split, so use `npm run frontend` for the checked-in site artifacts.

## Scripts

| Script | What it does |
|---|---|
| `npm run frontend` | Serve `docs/` as static files at `http://127.0.0.1:8000` |
| `npm run mcp:install` | Install dependencies for `mcp-server/` |
| `npm run mcp:dry-run` | Validate the WorkIQ MCP manifest without starting transport |
| `npm run mcp:start` | Start the hosted MCP server for the demo-boards WorkIQ manifest at `http://127.0.0.1:7801/mcp` |
| `npm run clean` | Wipe runtime state in `demo-board/boards/live/` (preserves cards) |
| `npm run stop` | Kill processes on ports 7799, 7801 and 8000 |

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
