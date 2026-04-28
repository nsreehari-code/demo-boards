---
name: board-validate-card
description: >
  Validate board card JSON files using the board-live-cards-cli.
  Use after creating or editing any card JSON to catch schema errors,
  expression syntax issues, and source-def problems before they hit runtime.
---

# Validate Board Cards

## When to Use

Run validation **every time** you create, edit, or modify a card JSON file.
Validation catches schema violations, bad JSONata expressions, invalid
provides/requires references, and unsupported source-def fields — before
the runtime ever sees the card.

## CLI Commands

### Validate a single card

```bash
npx board-live-cards-cli validate-card --card <path-to-card.json> --rg <board-runtime-dir>
```

- `--card` — path to the card JSON file
- `--rg`   — path to the board runtime directory (contains `.task-executor` file)

### Validate multiple cards (glob)

```bash
npx board-live-cards-cli validate-card --card-glob "cards/*.json" --rg <board-runtime-dir>
```

- `--card-glob` — glob pattern matching one or more card JSON files

### Exit codes

- **0** — all cards pass validation
- **1** — one or more cards have errors (details printed to stderr)

## What Gets Validated

1. **JSON Schema** — required fields (`id`), correct types, no unknown
   top-level properties.
2. **Runtime expressions** — JSONata syntax in `compute` steps is parsed
   and checked.
3. **provides/requires** — `provides[].ref` namespaces and `requires[]`
   IDs are verified for consistency.
4. **source_defs** — each source def is forwarded to the task executor's
   `validate-source-def` subcommand, which checks kind-specific required
   fields (e.g. `copilot` needs `copilot.prompt_template`, `url` needs
   `url.url`, `teams` needs `teams.action`).

## Typical Workflow

1. Edit or create a card JSON file.
2. Run `validate-card` on it.
3. Fix any reported errors.
4. The server will auto-upsert the changed card into the live board
   (no manual upsert step needed).
