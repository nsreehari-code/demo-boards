---
name: manage-cards-on-live-board
description: >
  Author a new card, edit an existing card, or change live board membership
  through staged management wrappers. Covers the full create / edit / read /
  upsert / deprecate lifecycle on the live runtime graph.
---

# Manage Cards On The Live Board

## When To Use

Use this skill whenever the task changes a card or board membership:

- create a new card
- edit / fix / repair an existing card
- read the exact stored card before changing it
- upsert a candidate card into the live board runtime
- deprecate (remove) a card from the live board runtime

This skill is the single home for the create-or-mutate side of cards. For
reading state without changes, use `inspect-board-and-card-state`. For
correctness checks before persisting changes, use `preflight-card-changes`.

## What A Board Is

- A board is a live runtime graph of cards and token dependencies.
- Cards are declarative; they do not call each other directly.
- The runtime owns reactivity, dependency ordering, and downstream retriggers.
- A card participates in the board by declaring `requires[]` and `provides[]`.

Adding a card to the board adds a node to the live dependency graph, not just a
JSON record. Removing a card removes its node and its published tokens.

## Card Shape

Start authoring from the smallest viable shape and add only what the card needs:

```json
{
  "id": "card-id",
  "meta": { "title": "Card Title" },
  "requires": [],
  "source_defs": [],
  "compute": [],
  "provides": [],
  "view": {
    "elements": [],
    "layout": {
      "board": { "col": 4, "order": 1 },
      "canvas": { "x": 50, "y": 50, "w": 280, "h": 220 }
    },
    "features": { "refresh": true, "chat": true }
  },
  "card_data": {}
}
```

## Core Dataflow Rules

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

## Source Authoring Rules

- Every source entry has unique `bindTo` and `outputFile` within the card.
- Fields beyond the shared `commonSourceDefFields` are kind-specific — query
  them via `discover-board-capabilities` instead of guessing from neighbors.
- If completion should not be blocked by a source, set
  `optionalForCompletionGating: true` on that source.
- All LLM behavior belongs in `source_defs[]`. Do not invent a non-source
  mechanism for LLM work.

## Command Surface

Run these from the Copilot workspace root using the staged CLI in
`.github/scripts`.

### Read the exact stored card

```bash
node ./.github/scripts/manage-live-board-card.js read-card --card-id <card-id>
```

Use this when you need the raw stored card as the basis for a precise repair.

### Upsert a card into the live board

```bash
cat payload.json | node ./.github/scripts/manage-live-board-card.js upsert-card --card-id <card-id>
```

Payload:

```json
{ "candidate_card_content": { "id": "<card-id>" /* full card */ } }
```

`upsert-card` validates the candidate, persists it, and syncs it into the live
graph in one step. The candidate's `id` must match `--card-id`.

This is the default persistence path after authoring or editing.

### Deprecate (remove) a card from the live board

```bash
node ./.github/scripts/manage-live-board-card.js deprecate --card-id <card-id>
```

Removes the card's node and its published tokens from the live graph. Be
mindful: downstream consumers may then be left waiting on missing tokens.

## Create A New Card

Use this playbook when the task is to introduce a new live-board card.

### Discipline

- Start from the minimum card shape above.
- Choose a stable `id`; never rename it later.
- Reuse shapes from nearby cards when they already solve the same problem; do
  not copy fields blindly.
- One responsibility per card; do not bundle unrelated workflows.
- It is acceptable to author `card_data` here — authoring defines the initial
  user-facing data shape.

### Choosing What To Do First

There is no fixed order. Pick by what's actually missing or unclear:

- *"Make me a card that tracks X"* and a similar card already exists on the
  board — inspect it once via `inspect-board-and-card-state` so the new
  card follows the same shape. If you already know the shape, skip this.
- *"I'm not sure how to author the source for this"* — use
  `discover-board-capabilities` for the kind and its `inputSchema`. If you
  already know the source kind well, skip this.
- *"There were decisions in another card's chat that matter"* — read that
  chat through `inspect-board-and-card-state`.
- *Otherwise* — author the card from the minimum shape above and `upsert-card`.

Before declaring the new card done: if it has `source_defs[]`, `compute[]`,
`provides[]`, or non-trivial `view` bindings, run `preflight-card-changes`.

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

See [agent-instructions-2-cardlayout.md](../../instructions/agent-instructions-2-cardlayout.md)
for the per-kind data-shape contracts and chart authoring rules.

## Edit An Existing Card

Use this playbook when the task is to change an existing card rather than
create one.

### Discipline

- Read the exact stored card first via `read-card`.
- Keep the edit as narrow as possible — one layout slice, one source, one
  compute path, or one data section at a time.
- Never change an existing card's `id`.
- Preserve fields and behavior outside the requested change.
- Preserve existing naming, `bindTo`, `outputFile`, `requires`, `provides`
  entries unless they are part of the requested repair.
- Treat `card_data` as protected user content. Only touch it for narrow syntax
  / formatting / structural repairs — not as a routine authoring surface.
- If the card already contains a working pattern for the same kind of field,
  follow that pattern rather than inventing a new shape.

### Contract repairs

- `requires[]` and `provides[]` are editable when the task is fixing a broken
  token contract.
- If the task changes `source_defs[]` shape or fields, confirm valid kinds and
  fields via `discover-board-capabilities` before editing.
- Keep `projections` limited to `card_data` and `requires`.
- LLM behavior stays inside `source_defs[]`.

### Choosing What To Do First

There is no fixed order. Pick by what the edit actually needs:

- *"Fix the X on this card"* and you don't have the current card in mind —
  `read-card` to get the exact stored shape. If you already have it from an
  earlier turn, skip this.
- *"Change a `source_defs[]` field"* and you're not sure the field is even
  valid for that source kind — `discover-board-capabilities`. Skip if you
  already know.
- *"The user attached a file that matters for the fix"* — surface it via
  `inspect-board-and-card-state` (card-level `refs-for-attached-files` or
  chat-level `file_refs`), then `inspect-file-contents.js`.
- *Otherwise* — make the smallest edit that addresses the request and
  `upsert-card` the repaired card.

Before declaring the edit done: if the change touches `source_defs[]`,
`compute[]`, `requires[]`, `provides[]`, or `view`, run
`preflight-card-changes`. Stop after the requested card is correct; do not
expand into unrelated cleanup.

## Command Rules

- Use `read-card` when you need the exact stored card as the basis for a
  repair. Use `inspect-card-definition-and-runtime.js`
  (`inspect-board-and-card-state`) when you also need live runtime context.
- Use `upsert-card` for both new cards and edits — it is the one full-card
  persistence path.
- Use `deprecate` for live removal; do not invent a storage deletion path.
- The candidate `id` must match `--card-id` on `upsert-card`.
- Do not route persistence through raw bundled store CLIs; this skill's staged
  wrappers are the only authoring surface.

## Related Skills

These are not next steps in a pipeline — reach for them when the intent
shifts:

- `preflight-card-changes` is the correctness gate. If your change can affect
  behavior, the task is not done until preflight passes for the changed card.
- `discover-board-capabilities` answers "is this source field valid?" / "what
  source kinds are available?".
- `provide-final-reply-to-user` is the terminal write when the turn ends with
  a user-visible answer.
