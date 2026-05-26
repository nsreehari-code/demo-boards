---
name: inspect-card-chat-history
description: >
  Read-only inspection of chat history on a live board card, including user
  attachment file refs and upload-related system file refs.
---

# Inspect Card Chat History

## When To Use

Use this skill when you need to read what was said on a specific card without
changing anything.

Typical questions this skill answers:

- What did the user say about this card?
- What did the assistant or system say in response?
- Which files were attached in chat?
- What is the recent user-turn-bounded suffix of the conversation?

Don't use this skill to change cards, save anything, or send the final
user-visible reply. Use `inspect-attachments-file-contents` when you already
have a `file_ref` and need the attachment contents.

## Command Surface

Run these from the Copilot workspace root.

### Card chat history

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js --card-id <card-id> get-messages
node ./.github/scripts/inspect-chat-messages-on-cards.js --card-id <card-id> --last-user-turns <n> get-messages
node ./.github/scripts/inspect-chat-messages-on-cards.js --card-id <card-id> --tail <n> get-messages
```

Returns the conversation on a card. Prefer `--last-user-turns <n>` when you
want the suffix beginning at the Nth-last user turn. Use `--tail <n>` only when
you explicitly want the last N messages regardless of role boundaries.
Messages carry `file_refs` for user attachments and `file_ref` on
upload-related system messages.

## Command Rules

- This command is read-only. Don't change cards, runtime, or chat.
- Prefer `--last-user-turns <n>` when the question is about recent turns.
- Use `--tail <n>` only when you want a raw message suffix and role boundaries
  do not matter.
- If you need the contents of an attachment, switch to
  `inspect-attachments-file-contents` after extracting the relevant `file_ref`.
- If you need broader board or card runtime context, switch to
  `inspect-board-and-card-state`.

## Choosing What To Read

- *"What did the user say about this card?"* — use `get-messages`.
- *"Show me only the recent user-turn-bounded context."* — use
  `--last-user-turns <n> get-messages`.
- *"Show me the raw last few chat messages."* — use `--tail <n> get-messages`.
- *"Which file was uploaded in chat?"* — read the chat history and extract the
  `file_ref` or `file_refs`, then switch to `inspect-attachments-file-contents`
  if you need file contents.

## Related Skills

- `inspect-board-and-card-state` — when you need board status or the full card
  view in addition to chat history.
- `inspect-attachments-file-contents` — when you already have a `file_ref` and
  need attachment contents.
- `manage-cards-on-live-board` — when the task moves from reading to changing a
  card or board membership.
