---
name: chat-store-commands
description: >
  Read board card chat history through the staged board-ref inspection wrapper,
  or append the final assistant reply through the staged board-ref append
  wrapper. Use when a task needs to inspect the current card's chat session,
  consult another card's chats, or append the final assistant reply into chat storage.
---

# Chat Store Commands

## When to Use

Use this skill whenever a task needs to inspect chat history or chat session
for a board card, or persist the final assistant reply into the chat store.

Use it especially when the task already has:

- `base-ref` and `card-id` for read-only chat inspection
- `base-ref` and `card-id` for final assistant-message append
- a reason to inspect the current card chat or another card's chat history

When using this skill to write, only append the final assistant reply. Do not
use it for internal notes, status updates, or orchestration state changes.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js <command>
```

### Read the full chat history for one card

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> get-messages
```

Use this as the default way to inspect the complete stored chat session for one
card.

### Read only the tail of one card chat

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> --tail <n> get-messages
```

Use this when only recent chat turns matter.

### Append the final assistant reply for one card

```bash
cat payload.json | node ./.github/scripts/provide-response-to-user.js --base-ref <board-ref> --card-id <card-id>
```

Use this only once per completed assistant turn, after the final user-visible
reply text is ready.

Payload shape:

```json
{ "text": "<final-user-reply>", "files": [] }
```

## Command Rules

- Prefer `inspect-chat-messages-on-cards.js` for read-only chat inspection.
- Use `provide-response-to-user.js` only for the final assistant reply that the user should see.
- Do not append partial drafts, reasoning traces, tool transcripts, or duplicate replies.
- Do not use `read-after`, `clear`, `set-processing`, `is-processing`, `get-config`, or `set-config` from this skill.
- Do not scan many unrelated card chats without a concrete reason.

## Recommended Workflow

1. For read-only inspection, identify the exact `base-ref` and `card-id` whose chat session matters.
2. Use `inspect-chat-messages-on-cards.js` to materialize the relevant chat history.
3. If the task requires delivering a final user reply, append exactly one assistant message with `provide-response-to-user.js`.
4. Leave processing-state changes to orchestration.