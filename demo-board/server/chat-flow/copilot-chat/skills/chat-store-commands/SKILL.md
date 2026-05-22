---
name: chat-store-commands
description: >
  Read board card chat history through the current yaml-flow chat store CLI
  using `store-ref` and card id. Use when a task needs to inspect the current
  card's chat session, consult another card's chats, or append the final
  assistant reply into chat storage.
---

# Chat Store Commands

## When to Use

Use this skill whenever a task needs to inspect chat history or chat session
for a board card, or persist the final assistant reply into the chat store.

Use it especially when the task already has:

- `storeRef`
- `cardId`
- a reason to inspect the current card chat or another card's chat history

When using this skill to write, only append the final assistant reply. Do not
use it for internal notes, status updates, or orchestration state changes.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/chat-store-cli.mjs <subcommand>
```

### Read the full chat history for one card

```bash
node ./.github/scripts/chat-store-cli.mjs read-all --store-ref <store-ref> --card-id <card-id>
```

Use this as the default way to inspect the complete stored chat session for one
card.

### Append the final assistant reply for one card

```bash
node ./.github/scripts/chat-store-cli.mjs append --store-ref <store-ref> --card-id <card-id> --role assistant --text "<final-user-reply>" --files-json "[]"
```

Use this only once per completed assistant turn, after the final user-visible
reply text is ready.

## Command Rules

- Prefer reading the current card's chat first unless the task clearly depends on another card's chat history.
- Use `append` only for the final assistant reply that the user should see.
- Do not append partial drafts, reasoning traces, tool transcripts, or duplicate replies.
- Do not use `read-after`, `clear`, `set-processing`, `is-processing`, `get-config`, or `set-config` from this skill.
- Do not scan many unrelated card chats without a concrete reason.

## Recommended Workflow

1. Identify the exact `storeRef` and `cardId` whose chat session matters.
2. Use `read-all` to materialize the relevant chat history.
3. If the task requires delivering a final user reply, append exactly one assistant message with `append`.
4. Leave processing-state changes to orchestration.