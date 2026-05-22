---
name: card-store-commands
description: >
  Read, write, and patch board cards through the current yaml-flow card store
  CLI using `store-ref` and card id. Use whenever a skill needs the
  command surface for loading or persisting cards.
---

# Card Store Commands

## When to Use

Use this skill whenever a task needs to load a card from a board card store or
write a changed card back to that store.

Use it especially when the task already has:

- `store-ref`
- `cardId`
- a repaired or newly authored card object

Cards are treated as non-deletable from the card store in this workflow. Once a
card has been added to the card store, do not delete it from storage.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/card-store-cli.mjs <subcommand>
```

### Read one card

```bash
node ./.github/scripts/card-store-cli.mjs get --store-ref <store-ref> --id <card-id>
```

Use this as the default way to materialize a stored card for editing or validation.

### Read all cards in a store

```bash
node ./.github/scripts/card-store-cli.mjs get --store-ref <store-ref>
```

Use this only when you need one or two nearby examples or need to inspect store contents.

### Write one card or a batch of cards

```bash
node ./.github/scripts/card-store-cli.mjs set --store-ref <store-ref>
```

`set` accepts a single card object or an array of cards on stdin. Each card must contain a string `id` field.

Use this as the default persistence path after editing a full card object or authoring a new card.

### Patch one object-style field

```bash
node ./.github/scripts/card-store-cli.mjs patch --store-ref <store-ref> --id <card-id> --path <dot.path> --value-json '<json-value>'
```

Use this only for narrow object-field updates such as:

- `card_data.title`
- `view.header`
- other small scalar or object-valued fields

Do not use `card-store-cli del` from this workflow. If a card should disappear
for users, remove it from the live board with `node ./.github/scripts/board-live-cards-cli.mjs remove-card`.
That is sufficient for the graph and for user-visible board behavior.

## Command Rules

- Prefer `get --id` when working on one requested card.
- Prefer `set` after editing the full card object.
- Use `patch` only for narrow object-style updates.
- Do not use `patch` for array-heavy fields such as `source_defs`, `compute`, `requires`, or `provides`.
- After `set` or `patch`, read the card again with `get --id` if you need to confirm the stored shape before validation.
- Do not use `del` from this workflow.
- If a card should no longer be visible to users, remove it from the live board; deleting it from the card store is not required.

## Recommended Workflow

1. Load the current card with `get --store-ref <store-ref> --id <card-id>`.
2. Make the smallest intended change outside the store.
3. Persist the result with `set`, or use `patch` only if the update is a small object-style field assignment.
4. Read the card again if you need to confirm what is stored.
5. If the goal is to hide a card from the board, hand off to `add-remove-card-from-board` instead of deleting from storage.
6. Hand off to correctness validation when the task is create/edit/repair rather than raw store administration.