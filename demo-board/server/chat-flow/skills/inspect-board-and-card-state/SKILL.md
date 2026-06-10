---
name: inspect-board-and-card-state
description: >
  Read-only inspection of a live board: runtime status and a full card view
  (definition + runtime outputs + computed values + file refs) through
  `liveboards.inspect.*` and `liveboards.manage.read-card`.
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

All commands here are read-only.

## MCP Surface

Pass the runtime `boardId` as `board_id` and the runtime `logId` as `log_id`
(opaque; forward unchanged). Add the runtime `cardId` as `card_id` when the
tool targets a single card.

### Board runtime status

```json
Tool: liveboards.inspect.board-runtime-status
Arguments: { "board_id": "<boardId>", "log_id": "<logId>" }
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

### Full card view (definition + runtime + file refs)

```json
Tool: liveboards.inspect.card-definition-and-runtime
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>" }
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
  "refs_for_fetched_source_files": { "<outputFile>": "sha256:..." },
  "runtime_data": {
    "requires": { "<token>": {} },
    "provides": { "<output-key>": {} },
    "computed_values": {},
    "rendered_view": {
      "elements": [ { "id": "...", "kind": "...", "label": "...", "visible": true, "resolved": "..." } ]
    }
  }
}
```

This is a snapshot only — no preflight, simulation, or compute evaluation.

### Exact stored card JSON (use before repairing a card)

```json
Tool: liveboards.manage.read-card
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>" }
```

Use this when you're about to edit a card and need its exact current shape
as the starting point, without any runtime data mixed in.

## Choosing What To Read

Read only what the question needs. There is no fixed sequence — jump straight
to the right command.

- *"Why is this card stale / blocked / why hasn't this finished?"* —
  `liveboards.inspect.board-runtime-status` for the board-wide picture.
- *"What does this card show / what did it publish / how is it computed?"* —
  `liveboards.inspect.card-definition-and-runtime` for the full card view in one read.
- *"What did the user say about this card / what did we agree?"* — use
  `inspect-card-chat-history`.
- *"I'm about to repair this card and need its exact current shape."* —
  `liveboards.manage.read-card`. (Use the full card view instead if
  you also need runtime context.)

## Related Skills

- `inspect-attachments-file-contents` — when you already have a `file_ref`
  and need the contents of an attached file.
- `inspect-card-chat-history` — when you need to inspect card chat messages or
  extract chat-level attachment refs.
- `manage-cards-on-live-board` — when the task moves from reading to changing
  a card or board membership.
- `preflight-card-changes` — when reading suggests a card is broken and you
  need to validate or simulate a fix.
