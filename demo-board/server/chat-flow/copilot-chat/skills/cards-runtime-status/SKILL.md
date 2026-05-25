---
name: cards-runtime-status
description: >
  Inspect live board and cards runtime status, published outputs, and computed values
  through the staged inspect wrappers using `base-ref`. Use
  this when a task needs runtime state rather than stored card definitions,
  or when a task needs one stitched card-level read model combining stored
  definition with live runtime artifacts.
---

# Cards Runtime Status

## When to Use

Use this skill whenever the task is about live runtime state on a board:

- inspect the current board execution status
- check whether cards are completed, blocked, failed, or in progress
- read published output objects from the runtime outputs store
- read computed values written for a specific card or for all cards
- understand whether a runtime issue is in live execution rather than stored card definitions

Do not use this skill when the real task is to edit cards in storage. Use
`card-store-commands`, `card-editing`, or `card-authoring` for that.

## What This Reads

- `status` reads the runtime status snapshot for the board
- `read-data-object` and `read-all-data-objects` read published runtime output objects
- `read-card-computed-values` and `read-all-computed-values` read per-card computed values from the outputs store
- `inspect-card-definition-and-runtime` stitches one card's stored definition and static data together with its live runtime artifacts

These commands inspect live runtime artifacts, not the source card definition.

The exception is `inspect-card-definition-and-runtime`, which is intentionally
a stitched holistic view: it reads the stored card definition from the card
store, reads live runtime artifacts from board status and outputs, and only
materializes `view_model` locally.

`read-status` returns only this compact board-status shape:

```jsonc
{
  "meta": { /* preserved from runtime status */ },
  "summary": {
    "card_count": 0,
    "completed": 0,
    "eligible": 0,
    "pending": 0,
    "blocked": 0,
    "in_progress": 0,
    "failed": 0,
    "unresolved": 0
  },
  "cards": [
    {
      "card-id": "<card-id>",
      "status": "<runtime-status>",
      "error": null,
      "requires": [],
      "requires_satisfied": [],
      "requires_missing": [],
      "provides_declared": [],
      "provides_runtime": []
    }
  ]
}
```

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/inspect-board-runtime-status.js <subcommand>
```

### Read overall board runtime status

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-status --base-ref <board-ref>
```

Use this as the default entrypoint when you need to know whether cards are:

- completed
- failed
- pending
- blocked
- unresolved
- in progress

This is the fastest way to understand the current live board state before drilling into a specific runtime output.

### Read one published runtime output object

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-data-object --base-ref <board-ref> --output-key <output-key>
```

Use this when a card or runtime process publishes a named output object and you know the key.

### Read all published runtime output objects

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-all-data-objects --base-ref <board-ref>
```

Use this only when you need a board-wide output scan.

### Read computed values for one card

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-card-computed-values --base-ref <board-ref> --card-id <card-id>
```

Use this when you need the live computed values for one specific card.

This is the direct way to inspect what `compute[]` has produced for that card in the runtime.

### Read computed values for all cards

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-all-computed-values --base-ref <board-ref>
```

Use this only when you need a board-wide computed-values inspection.

### Read one holistic card definition and runtime view

```bash
node ./.github/scripts/inspect-card-definition-and-runtime.js --base-ref <board-ref> --card-id <card-id>
```

Use this when you need one card's stored definition together with the live
runtime data that already exists for it.

This command returns this shape:

```jsonc
{
  "cardId": "<card-id>",
  "card_status_in_board": { /* exact raw card object from board status */ },
  "card_definition_and_static_data": { /* exact stored card object */ },
  "refs-for-attached-files": [
    { "index": 0, "file_ref": "..." }
  ],
  "refs_for_fetched_sources_files": {
    "<outputFile>": "b64:..."
  },
  "runtime_data": {
    "requires": {
      "<require-token>": {}
    },
    "provides": {
      "<provided-output-key>": {}
    },
    "computed_values": {},
    "view_model": {}
  }
}
```

Rules for this command:

- it is read-only
- it does not run source preflight, full cycle simulation, or compute evaluation
- it reads `requires` and `provides` from live runtime outputs
- it reads fetched-source file refs from live runtime outputs when they exist
- it computes only `view_model` locally from the stored card definition plus live runtime data

## Command Rules

- Always use `base-ref` for this skill. These are board-runtime commands.
- Prefer `read-status` first when the task is general runtime diagnosis.
- Prefer single-key reads over `read-all-*` unless the task is explicitly board-wide.
- Treat `read-card-computed-values` as runtime inspection, not as a substitute for reading card definitions.
- Use `inspect-card-definition-and-runtime` when the task genuinely needs both the stored card and current runtime artifacts in one response.
- If the issue is about stored card structure, switch to `card-store-commands` or correctness skills.
- If the issue is about whether a card is live on the board, combine this skill with `add-remove-card-from-board`.

## Recommended Workflow

1. Start with `read-status --base-ref <board-ref>` to understand the current runtime state.
2. If the issue is about a published output object, use `read-data-object`.
3. If the issue is about a card's compute result, use `read-card-computed-values --card-id <card-id>`.
4. If the task needs a holistic one-card view, use `inspect-card-definition-and-runtime --card-id <card-id>`.
5. Only use `--all` when the task really needs a board-wide scan.
6. If runtime state looks wrong because the card definition is wrong, move to card editing or correctness validation next.