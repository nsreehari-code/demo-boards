---
name: provide-final-reply-to-user
description: >
  Stage the single final assistant reply for a card through
  `liveboards.stage-ai-response-and-any-attachments`.
---

# Provide Final Reply To User

## When To Use

Use this skill only at the very end of an assistant turn, when the final
user-visible reply text is ready.

This stages the terminal reply for the current turn. Use only for the final user-visible reply — not for intermediate notes, status, reasoning traces, or duplicate replies.

## MCP Surface

Use `liveboards.stage-ai-response-and-any-attachments`.

Arguments:

```json
{
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "card_id": "<cardId>",
  "turn-id": "<turnId>",
  "text": "<final-user-reply>",
  "files": []
}
```

Pass the runtime handles supplied in the prompt: `boardId` as `board_id`,
`logId` as `log_id` (opaque; forward unchanged), `cardId` as `card_id`, and
`turnId` as `turn-id`. All four are required.

## Rules

- Call exactly once per turn.
- `text` is the final user-visible reply, not a draft or status update.
- If `files` is provided, it is staged as side data on the same assistant message.

## Handoff

This is a terminal skill. After a successful call, the turn is done.
