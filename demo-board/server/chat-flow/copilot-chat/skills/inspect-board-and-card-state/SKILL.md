---
name: inspect-board-and-card-state
description: >
  Read-only inspection of a live board: runtime status, a full card view
  (definition + runtime outputs + computed values + file refs), card chat
  history, and attached file contents.
---

# Inspect Board And Card State

## When To Use

Use this skill whenever you need to read what's on the board without
changing anything: how the board is running, what a card looks like and
what it has produced, what was said about the card in chat, and what's
inside any attached files.

Typical questions this skill answers:

- What is the board doing right now (completed / blocked / failed / pending)?
- What did this card publish or compute?
- What does this card's definition look like?
- What was said in this card's chat?
- Which files are attached on this card or in chat, and what do they contain?

Don't use this skill to change a card, save anything, or send the final
user-visible reply. The other skills cover those.

## Command Surface

Run these from the Copilot workspace root.

### Board runtime status

```bash
node ./.github/scripts/inspect-board-runtime-status.js read-status --base-ref <board-ref>
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
node ./.github/scripts/inspect-card-definition-and-runtime.js --base-ref <board-ref> --card-id <card-id>
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
node ./.github/scripts/manage-live-board-card.js read-card --store-ref <store-ref> --card-id <card-id>
```

Use this when you're about to edit a card and need its exact current shape
as the starting point, without any runtime data mixed in.

### Card chat history

```bash
node ./.github/scripts/inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> get-messages
node ./.github/scripts/inspect-chat-messages-on-cards.js --base-ref <board-ref> --card-id <card-id> --tail <n> get-messages
```

Returns the conversation on a card. Use `--tail <n>` when only recent turns
matter. Messages carry `file_refs` for user attachments and `file_ref` on
upload-related system messages.

### Attached file contents

```bash
node ./.github/scripts/inspect-file-contents.js --file-ref <file-ref>
```

Use a `file_ref` you already have from the card view (card-level attachments)
or from chat messages (chat-level attachments).

## Command Rules

- Every command here is read-only. Don't change cards, runtime, or chat.
- Reach for the full card view when you want both the card's definition and
  what it has produced (outputs, computed values, view) in a single read.
- Reach for `read-card` only when you're about to repair the card and need
  its exact current shape.
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
- *"What did the user say about this card / what did we agree?"* —
  `inspect-chat-messages-on-cards.js get-messages` (add `--tail <n>` if only
  recent turns matter).
- *"What was in that file the user attached?"* — take the `file_ref` from
  the card view or chat messages and pass it to `inspect-file-contents.js`.
- *"I'm about to repair this card and need its exact current shape."* —
  `manage-live-board-card.js read-card`. (Use the full card view instead if
  you also need runtime context.)

## Related Skills

These are not next steps in a pipeline — reach for them when the intent
shifts:

- `manage-cards-on-live-board` — when the task moves from reading to changing
  a card or board membership.
- `preflight-card-changes` — when reading suggests a card is broken and you
  need to validate or simulate a fix.
