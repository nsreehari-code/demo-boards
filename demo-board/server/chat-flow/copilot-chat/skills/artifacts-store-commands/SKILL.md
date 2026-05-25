---
name: artifacts-store-commands
description: >
  Read uploaded or attached files for a card/chat through the staged board-ref and
  file-ref inspection wrappers. Use for card or chat attachments when an agent
  needs to discover file refs or inspect file contents.
---

# Attached File Inspection

## When to Use

Use this skill whenever a task needs to inspect files uploaded or attached by a
user for a card or chat.

Use it especially when the task already has:

- `base-ref` and `card-id` and needs to discover attached file refs
- a `file-ref` and needs the file contents

This skill is read-only.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`.

### Read card-level attached file refs

```bash
node ./.github/scripts/inspect-card-definition-and-runtime.js --base-ref <board-ref> --card-id <card-id>
```

Use the top-level `refs-for-attached-files` array to discover file refs derived from `card_data.files` without changing the stored card payload.

### Read chat-level attached file refs

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> get-messages
```

Use this when the relevant file came through chat attachments or upload-related system messages. The chat inspect output already includes `file_refs` on attachment-bearing messages and `file_ref` on the relevant upload system messages.

### Read one attached file's contents

```bash
node ./.github/scripts/inspect-file-contents.js --file-ref <file-ref>
```

Use this after discovering the `file_ref` from card inspect or chat inspect.

## Command Rules

- Treat this skill as read-only.
- Do not mutate the stored card payload just to surface file refs.
- Prefer `refs-for-attached-files` from card inspect for card-level files.
- Prefer chat inspect when the file came through chat context or upload flow.
- Use the returned `file_ref` as the only input to `inspect-file-contents.js`.
- Do not use raw artifacts store write or delete surfaces from this skill.

## Recommended Workflow

1. Use `inspect-card-definition-and-runtime.js --base-ref <board-ref> --card-id <card-id>` when you need refs for files stored on the card itself.
2. Use `inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> get-messages` when you need refs from chat attachments or upload-related system messages.
3. Pick the correct `file_ref` from the returned inspect surface.
4. Use `inspect-file-contents.js --file-ref <file-ref>` when you need the file contents.
5. Keep the workflow read-only.