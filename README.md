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

2. Start the local backend (MCP server + hosted runtime):

```bash
npm start
```

3. Open the hosted frontend in your browser:

- https://nsreehari-code.github.io/demo-boards

## Frontend Source

- The frontend is hosted via GitHub Pages at https://nsreehari-code.github.io/demo-boards.
- Frontend source, build, and Pages deployment live in the separate `demo-boards-frontend` repo.

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the MCP server and hosted runtime locally (frontend is hosted at https://nsreehari-code.github.io/demo-boards) |
| `npm run mcp:install` | Install dependencies for `mcp-server/` |
| `npm run mcp:dry-run` | Validate the WorkIQ MCP manifest without starting transport |
| `npm run setup:check:copilot-only` | Smoke-check both Copilot wrappers with a simple query (`what is two plus two`) |
| `npm run setup:check:workiq-only` | Smoke-check direct WorkIQ CLI invocation with a simple query (`what is two plus two`) |
| `npm run setup:check:copilot-workiq` | Smoke-check both Copilot wrappers and run a direct WorkIQ CLI query (`what is two plus two`) without starting MCP |
| `npm run mcp:start` | Start the hosted MCP server for the demo-boards WorkIQ manifest at `http://127.0.0.1:7801/mcp` |
| `npm run clean` | Wipe runtime state in `demo-board/boards/live/` (preserves cards) |
| `npm run stop` | Kill processes on ports 7799 and 7801 |

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
