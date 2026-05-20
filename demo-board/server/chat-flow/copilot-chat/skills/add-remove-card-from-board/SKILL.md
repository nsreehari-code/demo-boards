---
name: add-remove-card-from-board
description: >
  Add a stored card to the live board runtime or remove a card from the live
  board with the right board-level mental model. Use when the task is about
  board membership, runtime dependencies, retriggers, and downstream effects,
  not just raw card persistence.
---

# Add Remove Card From Board

## When to Use

Use this skill when the task is about board-level presence and runtime effects:

- add a stored card to the board runtime
- refresh or restart a board card after a change
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

- `upsert-card` and `remove-card` operate on the live board runtime.
- This skill is about live board membership and runtime graph behavior.
- Use this skill to reason about whether a card should be active on the board,
  what tokens it contributes, and what downstream runtime effects follow.

Board-level meaning:

- `upsert-card` adds or resyncs a card node into the live graph from stored card definitions.
- `remove-card` removes that node from the live graph.
- For board behavior, deleting the card from the board is what matters; that is the operation that changes the live dependency graph.
- Neither command is a substitute for card authoring or correctness validation.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/board-live-cards-cli.js <subcommand>
```

### Add or sync one card into the board runtime

```bash
node ./.github/scripts/board-live-cards-cli.js upsert-card --base-ref <board-ref> --card-id <card-id>
```

Use this when the card already exists in the card store and should be made
present in the live board runtime.

This is the normal command for introducing a stored card into the board graph.
It makes the runtime see the card's `requires`, `provides`, sources, compute,
and view definition.

### Restart one card after syncing it

```bash
node ./.github/scripts/board-live-cards-cli.js upsert-card --base-ref <board-ref> --card-id <card-id> --restart
```

Use `--restart` when the card is already present but should be retriggered after
a material change.

Typical reasons:

- the stored card JSON changed materially
- the stored card definition changed materially
- its runtime should be re-evaluated immediately
- you want downstream dependents to see the fresh graph state

### Add or resync all stored cards

```bash
node ./.github/scripts/board-live-cards-cli.js upsert-card --base-ref <board-ref> --all
```

Use this only when the task explicitly calls for board-wide resync.

### Remove one card from the board runtime

```bash
node ./.github/scripts/board-live-cards-cli.js remove-card --base-ref <board-ref> --id <card-id>
```

Use this when the card should stop existing on the live board but should remain
inactive in the live runtime.

This removes the card's live presence and stops it from publishing tokens into
the board graph. For graph semantics, this is the deletion that matters.

## Command Rules

- Before `upsert-card`, make sure the target card already exists in the card store.
- Prefer single-card operations over `--all` unless the task is explicitly board-wide.
- If a card was just authored or edited, persist it first through `card-store-commands`, then upsert it into the board.
- If a card publishes tokens consumed by other cards, expect board behavior to change when it is removed.
- If a changed card should affect downstream dependents immediately, prefer `upsert-card --restart`.
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
3. If the card content changed, persist the card through `card-store-commands` first.
4. Use `upsert-card` to add or resync the card into the live board.
5. Use `upsert-card --restart` when the runtime should immediately retrigger from the new definition.
6. Use `remove-card` only for runtime removal from the board graph.
