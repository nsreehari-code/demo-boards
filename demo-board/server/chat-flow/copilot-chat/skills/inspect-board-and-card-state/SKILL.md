---
name: inspect-board-and-card-state
description: >
  Read-only inspection of a live board: runtime status and a full card view
  (definition + runtime outputs + computed values + file refs).
---

# Inspect Board And Card State

## When To Use

Use this skill whenever you need to read what's on the board without
changing anything: how the board is running, what a card looks like and
what it has produced.

Typical questions this skill answers:

- What is the board doing right now (completed / blocked / failed / pending)?
- What did this card publish or compute?
- What does this card's definition look like?

Don't use this skill to change a card, save anything, or send the final
user-visible reply. Use `inspect-card-chat-history` when you need chat
history, and `inspect-attachments-file-contents` when you need the contents of
an attachment.

## Command Surface

Run these from the Copilot workspace root.

### Board runtime status

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-status
```

Returns a compact board-status shape:

```jsonc
{
  "meta": { /* board-level metadata */ },
  "summary": { "card_count": 0, "completed": 0, "eligible": 0, "pending": 0, "blocked": 0, "in_progress": 0, "failed": 0, "unresolved": 0 },
  "cards": [
    { "card-id": "...", "status": "...", "error": null, "requires": [], "requires_satisfied": [], "requires_missing": [], "provides_declared": [], "provides_runtime": [] }
  ]
}
```

Use this when you need to know whether cards are completed, failed, pending,
blocked, unresolved, or in progress.

### Full card view (definition + runtime + file refs)

```bash
node ./.github/scripts/inspect-card-definition-and-runtime.js --card-id <card-id>
```

Returns everything you usually need to reason about a single card — its
definition, its current status on the board, what it has published, its
computed values, the rendered `view_model`, and any attached file refs:

```jsonc
{
  "cardId": "<card-id>",
  "card_status_in_board": { /* exact raw card object from board status */ },
  "card_definition_and_static_data": { /* exact stored card object */ },
  "refs-for-attached-files": [ { "index": 0, "file_ref": "..." } ],
  "refs_for_fetched_sources_files": { "<outputFile>": "b64:..." },
  "runtime_data": {
    "requires": { "<token>": {} },
    "provides": { "<output-key>": {} },
    "computed_values": {},
    "view_model": {}
  }
}
```

This command does not run preflight, simulation, or compute evaluation. It just provides the current snapshot. Use it when you need to investigate or understand the card's current state for answering any queries or taking any actions, etc.

### Exact stored card JSON (use before repairing a card)

```bash
node ./.github/scripts/manage-live-board-card.js read-card --card-id <card-id>
```

Use this when you're about to edit a card and need its exact current shape
as the starting point, without any runtime data mixed in.

## Command Rules

- Every command here is read-only. Don't change cards, runtime, or chat.
- Reach for the full card view when you want both the card's definition and
  what it has produced (outputs, computed values, view) in a single read.
- Reach for `read-card` only when you're about to repair the card and need
  its exact current shape.
- Use `inspect-card-chat-history` when you need to inspect what was said on a
  card or extract chat-level attachment refs.
- Use `inspect-attachments-file-contents` when you already have a `file_ref`
  and need the contents of an attachment.
- If the task turns into changing a card or board membership, switch to
  `manage-cards-on-live-board`.
- If the task turns into checking that a card would actually work, switch to
  `preflight-card-changes`.

## Choosing What To Read

Read only what the question needs. There is no fixed sequence — jump straight
to the right command.

- *"Why is this card stale / blocked / why hasn't this finished?"* —
  `inspect-board-runtime-status.js read-status` for the board-wide picture.
- *"What does this card show / what did it publish / how is it computed?"* —
  `inspect-card-definition-and-runtime.js` for the full card view in one read.
- *"What did the user say about this card / what did we agree?"* — use
  `inspect-card-chat-history`.
- *"I'm about to repair this card and need its exact current shape."* —
  `manage-live-board-card.js read-card`. (Use the full card view instead if
  you also need runtime context.)

## Related Skills

These are not next steps in a pipeline — reach for them when the intent
shifts:

- `inspect-attachments-file-contents` — when you already have a `file_ref`
  and need the contents of an attached file.
- `inspect-card-chat-history` — when you need to inspect card chat messages or
  extract chat-level attachment refs.
- `manage-cards-on-live-board` — when the task moves from reading to changing
  a card or board membership.
- `preflight-card-changes` — when reading suggests a card is broken and you
  need to validate or simulate a fix.
