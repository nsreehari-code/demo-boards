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
| `npm start` | Start backend (port 7799) + frontend (port 8000) together |
| `npm run backend` | Start backend API server only at `http://127.0.0.1:7799` |
| `npm run frontend` | Serve `demo-board/` as static files at `http://127.0.0.1:8000` |
| `npm run clean` | Wipe runtime state in `demo-board/live/` (preserves cards) |
| `npm run stop` | Kill processes on ports 7799 and 8000 |

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
```

## Environment variables (auto-set by `npm start`)

- `BOARD_LIVE_CARDS_CLI_JS` → local `yaml-flow` CLI path
- `DEMO_STEP_MACHINE_CLI_PATH` → local `yaml-flow` step-machine CLI path

## Notes

- Cards live in `demo-board/live/cards/` and are the single source of truth — no tmp-copy step.
- `demo-board/live/board-default/` is gitignored (runtime state).
- `npm run clean` preserves `live/cards/` and `live/gandalf-cards/`.
