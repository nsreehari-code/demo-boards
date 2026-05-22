---
name: artifacts-store-commands
description: >
  Read uploaded or attached artifacts for a card/chat from the current yaml-flow artifacts store
  using `store-ref` and artifact keys. Use for card or chat attachments when an
  agent needs to inspect artifacts.
---

# Artifacts Store Commands

## When to Use

Use this skill whenever a task needs to inspect artifacts uploaded or attached by a
user for a card or chat.

For both card uploads and chat attachments, the artifact key should normally
come from the stored card's `card_data.files` section after loading the card
through `card-store-commands`.

Use it especially when the task already has:

- `store-ref`
- an artifact key, or enough context to list candidate keys

This skill is read-only. Do not use write or delete operations from the
artifacts store CLI in this workflow.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/artifacts-store-cli.mjs <subcommand>
```

### Read one artifact as text

```bash
node ./.github/scripts/artifacts-store-cli.mjs get --store-ref <store-ref> --key <key> --as text
```

Use this for text-like artifacts such as JSON, Markdown, logs, YAML, or source files.

### Read one artifact as bytes metadata

```bash
node ./.github/scripts/artifacts-store-cli.mjs get --store-ref <store-ref> --key <key>
```

This returns artifact metadata plus byte length when printed to stdout.

### Read artifact metadata only

```bash
node ./.github/scripts/artifacts-store-cli.mjs head --store-ref <store-ref> --key <key>
```

Use this when you need to confirm existence, size, content type, or update time before fetching content.

### List artifact keys

```bash
node ./.github/scripts/artifacts-store-cli.mjs list --store-ref <store-ref>
```

Limit the scan when you know a prefix:

```bash
node ./.github/scripts/artifacts-store-cli.mjs list --store-ref <store-ref> --prefix <prefix>
```

Use this only when the needed file is not already discoverable from the stored
card metadata.

## Command Rules

- Treat this skill as read-only.
- For both card uploads and chat attachments, prefer reading the stored card first and taking the artifact key from `card_data.files`.
- Use `list --prefix` when you know part of the artifact namespace to avoid broad scans.
- Do not use `put` or `del` from this skill.

## Recommended Workflow

1. If you encounter any chat reference or need to refer to cards, load the card first and look in `card_data.files` for the artifact key.
2. If you still do not know the exact artifact key, use `list --store-ref <store-ref> [--prefix <prefix>]`.
3. Keep the operation read-only; do not modify the artifact store from this workflow.