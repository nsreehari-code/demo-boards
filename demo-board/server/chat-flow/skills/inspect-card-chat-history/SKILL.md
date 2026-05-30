---
name: inspect-card-chat-history
description: >
  Read-only inspection of chat history on a live board card, including user
  attachment file refs and upload-related system file refs, through
  `liveboards.inspect.chat-messages-on-cards`.
---

# Inspect Card Chat History

## When To Use

Use this skill to read chat history on a specific card without changing anything: user messages, assistant responses, system events, and attachment file refs.

## MCP Surface

Use `liveboards.inspect.chat-messages-on-cards`.

Pass the runtime `boardId` as `board_id`, the runtime `logId` as `log_id`
(opaque; forward unchanged), and the runtime `cardId` as `card_id`. Add the
runtime `turnId` as `turn-id` when you need the current turn only.

### Card chat history

```json
Tool: liveboards.inspect.chat-messages-on-cards
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>" }
```

Optional scoping fields (add at most one):

- `"tail-turns": <n>` — suffix starting at the Nth-last user turn.
- `"tail": <n>` — last N messages regardless of role.
- `"turn-id": "<turnId>"` — only the named turn.

Returns the conversation on a card. Prefer `tail-turns` when you want the
suffix beginning at the Nth-last user turn. Use `tail` only when you
explicitly want the last N messages regardless of role boundaries. Use
`turn-id` when the task is about the current turn only.
Messages carry `file_refs` for user attachments and `file_ref` on
upload-related system messages.

## Choosing What To Read

- *"What did the user say?"* — call `liveboards.inspect.chat-messages-on-cards`; use `tail-turns` to scope to recent user turns.
- *"Show me the raw last N messages"* — use `tail`.
- *"Show me only this turn"* — use `turn-id` with the runtime `turnId`.
- *"Which file was uploaded in chat?"* — extract the `file_ref` or `file_refs` from the history; switch to `inspect-attachments-file-contents` if you need the contents.

## Related Skills

- `inspect-board-and-card-state` — when you need board status or the full card
  view in addition to chat history.
- `inspect-attachments-file-contents` — when you already have a `file_ref` and
  need attachment contents.
- `manage-cards-on-live-board` — when the task moves from reading to changing a
  card or board membership.
