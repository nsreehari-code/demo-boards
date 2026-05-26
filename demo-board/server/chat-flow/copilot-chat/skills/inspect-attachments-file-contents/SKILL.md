---
name: inspect-attachments-file-contents
description: >
  Read the contents of an attached file on a live board using card id and
  merged file index.
---

# Inspect Attachments File Contents

## When To Use

Use this skill when you know the target card id and file index for an
attachment and need to read the file contents without changing anything.

Typical questions this skill answers:

- What is inside this attached file?
- Did the user-uploaded file contain the expected text or payload?
- What does a card-level or chat-level attachment actually contain?

Don't use this skill to discover which files exist on a card. Use
`inspect-board-and-card-state` first when you need to find the right card and
merged file index from chat history or card state.

## Command Surface

Run this from the Copilot workspace root.

### Attached file contents

```bash
node ./.github/scripts/inspect-file-contents.js --card-id <card-id> --file-idx <idx>
```

Use the card id and merged file index from the relevant system message, such as
`file uploaded: ... #1` or `AI generated: ... #0`.

The command returns the stored attachment contents for that card attachment.

## Command Rules

- This command is read-only. Don't change cards, runtime, or chat.
- Use this only after you already know the right card id and merged file index.
- If you still need to discover which files are attached, switch to
  `inspect-board-and-card-state` first.
- If the task turns into modifying a card or validating whether a repair would
  run correctly, switch to the more appropriate skill instead of extending this
  one.

## Choosing What To Read

- *"What was in that file the user attached?"* — run
  `inspect-file-contents.js --card-id <card-id> --file-idx <idx>`.
- *"What is inside this attachment mentioned in chat?"* — use the `#<idx>`
  suffix from the system message, then run `inspect-file-contents.js`.
- *"I do not know the right file index yet."* — use `inspect-board-and-card-state`
  first to inspect the chat messages and find the right index.

## Related Skills

- `inspect-board-and-card-state` — when you need to find the right card id and
  file index before reading contents.
- `manage-cards-on-live-board` — when the task moves from reading to changing
  cards or board membership.
- `preflight-card-changes` — when the task shifts from inspection to execution
  validation.