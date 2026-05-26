---
name: inspect-attachments-file-contents
description: >
  Read the contents of an attached file on a live board when you already have
  a file_ref from a card view or chat message.
---

# Inspect Attachments File Contents

## When To Use

Use this skill when you already have a `file_ref` for an attachment and need to
read the file contents without changing anything.

Typical questions this skill answers:

- What is inside this attached file?
- Did the user-uploaded file contain the expected text or payload?
- What does a card-level or chat-level attachment actually contain?

Don't use this skill to discover which files exist on a card. Use
`inspect-board-and-card-state` first when you need to find file refs.

## Command Surface

Run this from the Copilot workspace root.

### Attached file contents

```bash
node ./.github/scripts/inspect-file-contents.js --file-ref <file-ref>
```

Use a `file_ref` you already have from the full card view or from chat
messages.

The command returns the stored attachment contents for that exact ref.

## Command Rules

- This command is read-only. Don't change cards, runtime, or chat.
- Use this only after you already have a `file_ref`.
- If you still need to discover which files are attached, switch to
  `inspect-board-and-card-state` first.
- If the task turns into modifying a card or validating whether a repair would
  run correctly, switch to the more appropriate skill instead of extending this
  one.

## Choosing What To Read

- *"What was in that file the user attached?"* — run
  `inspect-file-contents.js --file-ref <file-ref>`.
- *"What is inside this card attachment?"* — get the `file_ref` from the full
  card view, then run `inspect-file-contents.js`.
- *"I do not have a file_ref yet."* — use `inspect-board-and-card-state`
  first to inspect the card view or chat messages and extract the right ref.

## Related Skills

- `inspect-board-and-card-state` — when you need to find the right `file_ref`
  before reading contents.
- `manage-cards-on-live-board` — when the task moves from reading to changing
  cards or board membership.
- `preflight-card-changes` — when the task shifts from inspection to execution
  validation.