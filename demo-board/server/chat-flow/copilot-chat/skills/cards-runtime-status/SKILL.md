---
name: cards-runtime-status
description: >
  Inspect live board and cards runtime status, published outputs, and computed values
  through the current yaml-flow board-live-cards CLI using `base-ref`. Use
  this when a task needs runtime state rather than stored card definitions.
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
- `get-outputs --type data-object` reads published runtime output objects
- `get-outputs --type computed-values` reads per-card computed values from the outputs store

These commands inspect live runtime artifacts, not the source card definition.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/board-live-cards-cli.js <subcommand>
```

### Read overall board runtime status

```bash
node ./.github/scripts/board-live-cards-cli.js status --base-ref <board-ref>
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
node ./.github/scripts/board-live-cards-cli.js get-outputs --base-ref <board-ref> --type data-object --key <output-key>
```

Use this when a card or runtime process publishes a named output object and you know the key.

### Read all published runtime output objects

```bash
node ./.github/scripts/board-live-cards-cli.js get-outputs --base-ref <board-ref> --type data-object --all
```

Use this only when you need a board-wide output scan.

### Read computed values for one card

```bash
node ./.github/scripts/board-live-cards-cli.js get-outputs --base-ref <board-ref> --type computed-values --key <card-id>
```

Use this when you need the live computed values for one specific card.

This is the direct way to inspect what `compute[]` has produced for that card in the runtime.

### Read computed values for all cards

```bash
node ./.github/scripts/board-live-cards-cli.js get-outputs --base-ref <board-ref> --type computed-values --all
```

Use this only when you need a board-wide computed-values inspection.

## Command Rules

- Always use `base-ref` for this skill. These are board-runtime commands.
- Prefer `status` first when the task is general runtime diagnosis.
- Prefer single-key reads over `--all` unless the task is explicitly board-wide.
- Treat `get-outputs --type computed-values` as runtime inspection, not as a substitute for reading card definitions.
- If the issue is about stored card structure, switch to `card-store-commands` or correctness skills.
- If the issue is about whether a card is live on the board, combine this skill with `add-remove-card-from-board`.

## Recommended Workflow

1. Start with `status --base-ref <board-ref>` to understand the current runtime state.
2. If the issue is about a published output object, use `get-outputs --type data-object`.
3. If the issue is about a card's compute result, use `get-outputs --type computed-values --key <card-id>`.
4. Only use `--all` when the task really needs a board-wide scan.
5. If runtime state looks wrong because the card definition is wrong, move to card editing or correctness validation next.