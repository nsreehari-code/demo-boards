---
name: inspect-attachments-file-contents
description: >
  Read the contents of an attached file on a live board using card id and
  merged file index through `liveboards.inspect.file-contents`.
---

# Inspect Attachments File Contents

## When To Use

Use this skill to read an attached file's contents when you already have the card id and merged file index. To discover which files exist or find the right index, use `inspect-board-and-card-state` first.

## MCP Surface

Pass the runtime `boardId` as `board_id`, the runtime `logId` as `log_id`
(opaque; forward unchanged), and the runtime `cardId` as `card_id`.

### Attached file contents

```json
Tool: liveboards.inspect.file-contents
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>", "file_idx": <idx> }
```

Use the card id and merged file index from the relevant system message, such as
`file uploaded: ... #1` or `AI generated: ... #0`.

This tool returns the raw attachment payload from the board server. Treat text
payloads as file contents; treat non-text payloads as binary attachment data.

## Choosing What To Read

- *"Read this attachment"* — call `liveboards.inspect.file-contents` with the card id and the `#<idx>` file index from the relevant system message.
- *"I don't know the file index yet"* — use `inspect-board-and-card-state` to find it first.

## Related Skills

- `inspect-board-and-card-state` — when you need to find the right card id and
  file index before reading contents.
- `manage-cards-on-live-board` — when the task moves from reading to changing
  cards or board membership.
- `preflight-card-changes` — when the task shifts from inspection to execution
  validation.