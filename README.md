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

2. Copy the example board into `default-board` (idempotent; skips if already present):

```bash
npm run setup
```

3. Start both servers (backend + static frontend server):

```bash
npm start
```

4. Open in browser:

- http://127.0.0.1:8000/demo-shell-with-server.html

## What `npm start` Runs

`npm start` runs `npm run start-server`, which starts:

- Backend demo server at `http://127.0.0.1:7799`
- Static file server at `http://127.0.0.1:8000`

The script also wires these environment variables automatically:

- `BOARD_LIVE_CARDS_CLI_JS` -> local `yaml-flow` CLI path
- `DEMO_STEP_MACHINE_CLI_PATH` -> local `yaml-flow` step-machine CLI path

## Scripts

- `npm run setup` -> copy `yaml-flow` example board into `default-board`
- `npm run copy-example-board` -> same as setup
- `npm run start-server` -> run backend + frontend servers
- `npm start` -> alias for `npm run start-server`

## Notes

- `default-board/` is gitignored.
- If `default-board` already exists, copy is skipped by design.
