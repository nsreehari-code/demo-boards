---
name: add-remove-card-from-board
description: >
  Add, inspect, or remove a live board card through the staged management
  wrapper with the right board-level mental model. Use when the task is about
  board membership, runtime dependencies, retriggers, and downstream effects,
  not just raw card persistence.
---

# Add Remove Card From Board

## When to Use

Use this skill when the task is about board-level presence and runtime effects:

- inspect one stored card before a live board operation
- inspect all stored cards in a store before a live board operation
- upsert a candidate card into the board runtime
- remove a card from the board runtime
- understand what adding or removing a card does to the token graph
- reason about downstream recompute after a card changes

Do not use this skill when the real task is to create, edit, or validate card
definitions in the card store.

## What a Board Is

- A board is a live runtime graph of cards and token dependencies.
- Cards are declarative. They do not call each other directly.
- The runtime owns reactivity, dependency ordering, and downstream retriggers.
- A card participates in the board by declaring what it `requires` and what it
  `provides`.

When you add a card to the board, you are not just making a definition available. You
are adding a node to the live dependency graph.

## What a Card Contributes

Each card can contribute four important things to the board:

- `source_defs[]` fetch external or derived source data into `fetched_sources.*`
- `compute[]` derives `computed_values.*`
- `view` renders UI from runtime namespaces
- `provides[]` publishes tokens for downstream cards

Each card can also consume board data through `requires[]`.

## Strict Dataflow Inside a Card

The runtime evaluates cards in this order:

1. `source_defs[]` runs first and may read only from `card_data` and `requires`
2. `compute[]` runs next and may read `card_data`, `requires`, and `fetched_sources`
3. `view` and `provides[]` resolve last and may read `card_data`, `requires`, `fetched_sources`, and `computed_values`

Important consequences:

- `source_defs` is configuration, not a runtime data namespace.
- Fetched source outputs live under `fetched_sources.*`.
- Published token refs in `provides[].ref` resolve from the card's runtime namespaces.

## provides / requires and the Board Graph

- `provides[]` publishes named tokens from this card into the board graph.
- `requires[]` declares which tokens this card consumes from upstream cards.
- The runtime builds the dependency graph automatically from these declarations.
- Consumed values appear inside the card at `requires.<token>`.
- For hyphenated token names, JSONata should use `$lookup(requires, 'my-token')`.

Removing a card from the board removes its node and its published tokens from
the live graph. Adding it back restores that node and its published outputs.

## What Retriggers Cards

Cards are live entities. Downstream recompute can happen when:

- a source finishes fetching and `fetched_sources.*` changes
- user interaction changes `card_data`
- an upstream card publishes a changed `provides` value
- a card definition is updated and resynced into the board

Authors do not manually wire recompute. The runtime handles dependency-ordered
propagation.

## Important Distinction

- `manage-live-board-card.js` is the authoritative staged management wrapper.
- This skill is about live board membership and runtime graph behavior.
- Use this skill to reason about whether a card should be active on the board,
  what tokens it contributes, and what downstream runtime effects follow.

Board-level meaning:

- `upsert-card` validates the candidate card, persists it to the store, and syncs it into the live graph with restart semantics.
- `deprecate` removes that node from the live graph.
- For board behavior, removing the card from the board is what changes the live dependency graph.
- These commands are not substitutes for card authoring or correctness validation; `upsert-card` only wraps the minimal validation needed before syncing live.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/manage-live-board-card.js <subcommand>
```

### Read one stored card before operating on it

```bash
node ./.github/scripts/manage-live-board-card.js read-card --store-ref <store-ref> --card-id <card-id>
```

Use this when you need to inspect the current stored card before deciding
whether to upsert or deprecate it.

### Read all stored cards in a store

```bash
node ./.github/scripts/manage-live-board-card.js read-all-cards --store-ref <store-ref>
```

Use this only when you need nearby examples or need to inspect the store before
a board-level decision.

### Upsert one card into the board runtime

```bash
cat payload.json | node ./.github/scripts/manage-live-board-card.js upsert-card --store-ref <store-ref> --base-ref <board-ref> --card-id <card-id>
```

Upsert payload shape:

```json
{
  "candidate_card_content": {
    "id": "<card-id>"
  }
}
```

Use this when the candidate card content should be persisted and made present
in the live board runtime in one step.

Typical reasons:

- the stored card JSON changed materially
- the card was newly authored and should now go live
- its runtime should be restarted immediately
- you want downstream dependents to see the fresh graph state

### Remove one card from the board runtime

```bash
node ./.github/scripts/manage-live-board-card.js deprecate --base-ref <board-ref> --card-id <card-id>
```

Use this when the card should stop existing on the live board but should remain
inactive in the live runtime.

This removes the card's live presence and stops it from publishing tokens into
the board graph. For graph semantics, this is the deletion that matters.

## Command Rules

- `upsert-card` expects `candidate_card_content` on stdin and validates that its `id` matches `--card-id`.
- `upsert-card` persists the candidate card to the store and syncs it into the board in one command.
- Use `read-card` if you need the current stored card before building the upsert payload.
- Use `read-all-cards` only when the task is explicitly store-wide.
- If a card publishes tokens consumed by other cards, expect board behavior to change when it is removed.
- Do not describe board membership changes as mere storage changes; they change the live graph.

## How to Think About Add vs Remove

Add a card when:

- the board should gain a new node
- the board should start exposing that card's published tokens
- downstream cards should be able to satisfy `requires[]` from it

Remove a card when:

- the board should stop exposing that card's tokens
- the runtime should stop treating the card as an active graph node
- downstream cards should no longer depend on that card's live outputs

Be careful: removing a provider card can leave downstream cards waiting on now-missing tokens.

## Recommended Workflow

1. Decide whether the task is about live presence, stored card data, or both.
2. Identify whether the card is mainly a source/provider, a compute consumer, a UI-only card, or a mix.
3. If you need the current stored shape, load it with `read-card` first.
4. Build the full `candidate_card_content` payload for the intended live card.
5. Use `upsert-card` to validate, persist, and sync the card into the live board.
6. Use `deprecate` only for runtime removal from the board graph.
