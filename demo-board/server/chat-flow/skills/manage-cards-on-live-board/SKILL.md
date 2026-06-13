---
name: manage-cards-on-live-board
description: >
  Author a new card, edit an existing card, or change live board membership
  through `liveboards.manage.*`. Covers the full create / edit / read /
  upsert / remove lifecycle on the live runtime graph.
---

# Manage Cards On The Live Board

## When To Use

Use this skill whenever the task changes a card or board membership:

- create a new card
- edit / fix / repair an existing card
- read the exact stored card before changing it
- upsert a candidate card into the live board runtime
- remove a card from the live board runtime and storage

This skill is the single home for the create-or-mutate side of cards. For
reading state without changes, use `inspect-board-and-card-state`. For
correctness checks before persisting changes, use `preflight-card-changes`.

## Card Shape

Start authoring from the smallest viable shape and add only what the card needs:

```json
{
  "id": "card-id",
  "meta": {
    "title": "Card Title",
    "presentation": {
      "footprint": "wide"
    }
  },
  "requires": [],
  "source_defs": [],
  "compute": [],
  "provides": [],
  "view": {
    "elements": []
  },
  "card_data": {}
}
```

## Presentation Semantics

Every card you author lives on the Main Canvas. Author only how the card should
*feel* to the user in `meta.presentation.*`; the frontend computes placement.

- `meta.presentation.prominence` — how much the user should care: `glance`, `standard`, `feature`, or `spotlight`. Default: `standard`; omit it unless the card should clearly feel lower or higher priority.
- `meta.presentation.footprint` — how much room the card needs to render well: `compact`, `standard`, `wide`, or `large`. Default: `standard`; omit it unless the card needs non-standard width.
- `meta.presentation.resizable` — whether the user may resize the card at runtime. Default: `true`; omit it unless the card must be fixed-size (`false`).

Content shape is inferred from `view.elements[].kind` — do not restate it.
Do not author `view.layout`, planes, columns, pixel widths, or coordinates.
The frontend computes initial canvas placement from board layout config,
runtime graph shape (`requires` / `provides`), and these semantic hints.
Live drag / resize coordinates are runtime-owned state and are persisted
separately from the card JSON.

## Path State (exploration lifecycle)

For exploration / journey boards, a card may belong to a line of inquiry that you
decide to park or rule out. Record that decision **on the card itself** so it is
durable and visible — never in a side journal. This is a pure annotation: it
changes only how the card body is rendered and how you read the board on a later
pass. It does **not** stop the reactive graph; tokens still flow to children.

- `meta.path_state` — lifecycle of this card's path. Omit it (the default) for an
  active path. Allowed values:
  - `suspended` — explored, nothing conclusive yet; parked to pursue other leads.
    You may re-enter it later. The body renders dimmed with a "Suspended" pill.
  - `dead_ended` — ruled out by evidence; do not re-open without new reason. The
    body renders greyed with a "Ruled out" pill.
  - `wiped` — exploration abandoned but kept as a breadcrumb ("I was here"). The
    body renders struck through with a "Wiped" pill.
- `meta.path_state_rationale` — one sentence on *why* you set the state (e.g.
  "30d lookback returned 0; ruling out the spray hypothesis"). Shown on hover.

Set these with the same card-authoring tools you use for any other `meta` field.
On a later cycle, read `meta.path_state` on existing cards to avoid re-walking a
`dead_ended` path and to decide whether a `suspended` one is worth resuming.
`path_state` is independent of `meta.presentation.*` (which is purely layout) and
of `card_data` (which is user-owned, not for agent lifecycle state).

## Core Dataflow

- One execution order:
  `source_defs[]` -> `fetched_sources.*` -> `compute[]` -> `computed_values.*` -> `view` and `provides[]`.
- `source_defs` is configuration, not a runtime namespace. Bindings that read
  fetched data point at `fetched_sources.*`.
- `compute[]` reads `requires.*`, `fetched_sources.*`, `card_data.*` and writes
  `computed_values.*`.
- `view` and `provides[]` may read `requires.*`, `fetched_sources.*`,
  `card_data.*`, `computed_values.*`.
- `provides[].ref` resolves from those same namespaces.
- `projections` on a source may read only from `card_data` and `requires`.
- For hyphenated required-token names, use `$lookup(requires, 'my-key')`.

## Source Authoring

- Every source entry has unique `bindTo` and `outputFile` within the card.
- Fields beyond the shared `commonSourceFields` are kind-specific — query
  them via `discover-board-capabilities` instead of guessing from neighbors.
- If completion should not be blocked by a source, set
  `optionalForCompletionGating: true` on that source.
- LLM behavior belongs in `source_defs[]`; avoid inventing parallel non-source mechanisms.

## MCP Surface

Pass the runtime `boardId` as `board_id`, the runtime `logId` as `log_id`
(opaque; forward unchanged), and the runtime `cardId` as `card_id`.

### Read the exact stored card

```json
Tool: liveboards.manage.read-card
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>" }
```

Use this when you need the raw stored card as the basis for a precise repair.

### Upsert a card into the live board

```json
Tool: liveboards.manage.upsert-card
Arguments:
{
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "card_id": "<cardId>",
  "candidate_card_content": { "id": "<cardId>", ... /* full card */ }
}
```

`upsert-card` validates the candidate, persists it, and syncs it into the live
graph in one step. The candidate's `id` must match `card_id`.

### Remove a card from the live board

```json
Tool: liveboards.manage.remove-card
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "card_id": "<cardId>" }
```

Removes the card from both the live board runtime and persistent storage. Downstream cards waiting on its published tokens will stall. Re-upserting a card with the same `card_id` after removal creates a fresh card with no prior state.

## Create A New Card

Use this playbook when the task is to introduce a new live-board card.

### Guidance

- Start from the minimum card shape above.
- Choose a stable `id`; renaming it later breaks board references.
- Reuse shapes from nearby cards when they already solve the same problem; avoid copying fields blindly.
- Aim for one responsibility per card.
- Author `card_data` to define the initial user-facing data shape.

### Choosing What To Do First

There is no fixed order. Pick by what's actually missing or unclear:

- *"Make me a card that tracks X"* and a similar card already exists on the
  board — inspect it once via `inspect-board-and-card-state` so the new
  card follows the same shape.
- *"I'm not sure how to author the source for this"* — use
  `discover-board-capabilities` for the kind and its `inputSchema`.
- *"There were decisions in another card's chat that matter"* — read that
  chat through `inspect-board-and-card-state`.
- *Otherwise* — author the card from the minimum shape above and `upsert-card`.

If the card has `source_defs[]`, `compute[]`, `provides[]`, or non-trivial `view` bindings, run `preflight-card-changes` before finishing.

### Starter patterns

- Root source card: source -> `fetched_sources.raw` -> `provides[]` -> table view.
- Compute chain card: `requires[]` -> `compute[]` -> `computed_values.*` ->
  `provides[]` or view.
- Input propagation: form / searchbox / selection writes to `card_data`, then
  downstream cards consume the published token through `requires[]`.
- LLM verdict: source fetches structured verdict JSON; compute / view / provides
  consume that result.

### View selection heuristics

- Default to `table` when the best rendering is not obvious.
- Use `editable-table`, `form`, `searchbox`, `selection`, or `todo` only when
  the user needs to edit state.
- Use `chart` only when there is a clear category / value mapping.
- Use `ref` only when the rendered kind should be chosen dynamically by user
  state, upstream data, or an LLM-provided `_view` hint. Keep `_view.kind`
  inside the supported renderer set and `_view.data` minimal.


## Edit An Existing Card

Use this playbook when the task is to change an existing card rather than
create one.

### Guidance

- Read the exact stored card first via `read-card`.
- Keep the edit as narrow as possible — one layout slice, one source, one
  compute path, or one data section at a time.
- Avoid changing an existing card's `id`; it breaks board references.
- Preserve fields and behavior outside the requested change.
- Preserve existing naming, `bindTo`, `outputFile`, `requires`, `provides`
  entries unless they are part of the requested repair.
- Treat `card_data` as user content; limit changes to narrow structural or formatting repairs.
- If the card already contains a working pattern for the same kind of field,
  follow that pattern rather than inventing a new shape.

### Choosing What To Do First

There is no fixed order. Pick by what the edit actually needs:

- *"Fix the X on this card"* and you don't have the current card in mind —
  `read-card` to get the exact stored shape. If you already have it from an
  earlier turn, skip this.
- *"Change a `source_defs[]` field"* and you're not sure the field is even
  valid for that source kind — `discover-board-capabilities`. Skip if you
  already know.
- *"The user attached a file that matters for the fix"* — use
  `inspect-card-chat-history` to find the chat system message with the
  `#<idx>` suffix, then `inspect-attachments-file-contents` to read it.
- *Otherwise* — make the smallest edit that addresses the request and
  `upsert-card` the repaired card.

If the change touches `source_defs[]`, `compute[]`, `requires[]`, `provides[]`, or `view`, run `preflight-card-changes`. Stop at the requested card; avoid expanding into unrelated cleanup.

## Related Skills

- `preflight-card-changes` — correctness gate; run after any change to `source_defs[]`, `compute[]`, `provides[]`, or `view`.
- `discover-board-capabilities` — source kind lookup and `inputSchema` before authoring or editing sources.
- `provide-final-reply-to-user` — terminal write when the turn ends with a user-visible answer.
