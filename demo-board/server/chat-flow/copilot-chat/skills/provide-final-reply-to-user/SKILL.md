---
name: provide-final-reply-to-user
description: >
  Stage the single final assistant reply for a card via the staged
  `provide-response-to-user.js` wrapper.
---

# Provide Final Reply To User

## When To Use

Use this skill only at the very end of an assistant turn, when the final
user-visible reply text is ready.

This stages the terminal reply for the current turn. The mediator appends it to
chat history after your run completes. It is not for internal notes, status
updates, reasoning traces, tool transcripts, partial drafts, orchestration
state, or duplicate replies.

To read chat history (current card or other cards on the board), use
`inspect-board-and-card-state`.

## Command Surface

Run from the Copilot workspace root.

```bash
cat payload.json | node ./.github/scripts/provide-response-to-user.js --card-id <card-id>
```

Payload:

```json
{ "text": "<final-user-reply>", "files": [] }
```

`text` is staged as the final reply payload. If `files` are provided, they are
staged into the same response container with generated file names.

Use the runtime handles passed into the prompt for `cardId`.

## Rules

- Call exactly once per completed assistant turn.
- `text` must be the final user-visible reply, not a draft.
- If `files` is provided, treat it as staged side data in the same container.
- Only `text` is currently consumed by the mediator after the run completes.
- Do not write partial responses or duplicate replies into the staged final-reply container.
- Do not use this skill to mutate processing state, config, or session
  metadata.

## Handoff

This is a terminal skill. After a successful call, the turn is done.
