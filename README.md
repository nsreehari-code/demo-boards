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

2. Start the backend server:

```bash
npm start
```

3. In a separate terminal, serve the frontend:

```bash
npm run serve
```

4. Open in browser:

- http://127.0.0.1:8000/

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start backend API server at `http://127.0.0.1:7799` |
| `npm run dev` | Start backend directly (no env-var wiring) |
| `npm run serve` | Serve `demo-board/` as static files at `http://127.0.0.1:8000` |
| `npm run clean` | Wipe runtime state in `demo-board/live/` (preserves cards) |
| `npm run stop` | Kill backend server on port 7799 |

## Directory structure

```
demo-board/
  live/
    cards/            <- source cards (git-tracked)
    gandalf-cards/    <- source gandalf cards (git-tracked)
    board-default/    <- runtime state (gitignored)
  demo-server.js
  demo-server-config.json
  demo-task-executor.js
  demo-chat-handler.js
  index.html
```

## Environment variables (auto-set by `npm start`)

- `BOARD_LIVE_CARDS_CLI_JS` → local `yaml-flow` CLI path
- `DEMO_STEP_MACHINE_CLI_PATH` → local `yaml-flow` step-machine CLI path

## Notes

- Cards live in `demo-board/live/cards/` and are the single source of truth — no tmp-copy step.
- `demo-board/live/board-default/` is gitignored (runtime state).
- `npm run clean` preserves `live/cards/` and `live/gandalf-cards/`.
