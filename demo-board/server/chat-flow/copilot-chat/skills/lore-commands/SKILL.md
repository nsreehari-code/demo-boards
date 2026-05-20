---
name: lore-commands
description: >
  Read, write, append, deprecate, and delete durable lore through the staged
  lore CLI. Use when a task needs to inspect or update board-level or user-level
  lore that should accumulate across interactions.
---

# Lore Commands

## When to Use

Use this skill whenever a task needs to inspect current lore or persist durable
board-level or user-level knowledge.

Use it especially when the task already has:

- one or more candidate lore items confirmed by the user, document, or prior accepted project record
- a need to check whether that knowledge already exists in lore
- a need to add, revise, extend, retire, or remove a lore entry

Use this skill only for durable knowledge that should remain useful across
cards, chats, and future sessions.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/lore-cli.js <subcommand>
```

### Read one lore entry

```bash
node ./.github/scripts/lore-cli.js get --key <key>
```

Use this when you need to inspect one known lore key.

### Read all active lore entries

```bash
node ./.github/scripts/lore-cli.js get-all
```

Use this as the default way to inspect the current active lore set.

### Read all lore entries including deprecated ones

```bash
node ./.github/scripts/lore-cli.js get-all --include-deprecated
```

Use this when you need historical context before deciding whether to revive,
replace, or retire an older entry.

### Create or replace one lore entry

```bash
node ./.github/scripts/lore-cli.js set --key <key> --value-json '<json-value>'
```

Use this when one durable lore item should be created or fully replaced.

### Extend one lore entry

```bash
node ./.github/scripts/lore-cli.js append --key <key> --value-json '<json-value>'
```

Use this when preserving prior value history is useful and the new information
should accumulate rather than replace.

### Deprecate one lore entry

```bash
node ./.github/scripts/lore-cli.js deprecate --key <key>
```

Use this when an entry should remain historically visible but should no longer
be treated as active.

### Delete one lore entry

```bash
node ./.github/scripts/lore-cli.js delete --key <key>
```

Use this only when an entry is clearly wrong and should be removed entirely.

## Command Rules

- Prefer `get-all` before writing when the task may overlap with existing lore.
- Prefer `set` for a clear durable fact or standing decision with one stable value.
- Prefer `append` when the entry should retain multiple confirmed values or a short history.
- Prefer `deprecate` over `delete` when an older rule or preference has been superseded.
- Use stable dotted keys such as `user.*`, `board.*`, `identity.*`, and `decision.*`.
- Keep values compact, self-contained, and structured when that improves later reuse.
- Do not store transient task state, one-off card context, or speculative interpretations.

## Recommended Workflow

1. Gather candidate lore items from the current task context and any relevant prior history.
2. Use `get-all` or `get --key` to inspect the current lore state.
3. Drop anything that fails the lore test for durability and confirmed usefulness.
4. Use `set`, `append`, `deprecate`, or `delete` as appropriate for each surviving item.
5. Re-read the affected entry or active lore set if you need to confirm the resulting state.