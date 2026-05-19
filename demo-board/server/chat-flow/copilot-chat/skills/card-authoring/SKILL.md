---
name: card-authoring
description: >
  Create a new board card from scratch or from a nearby example. Use when a
  task requires introducing a new card with its own `id`, `card_data`,
  `source_defs`, `compute`, `requires`, `provides`, `view`, or layout.
---

# Card Authoring

## When to Use

Use this skill when the task is to create a new card, not modify an existing
 one.

`card-store-commands` is a prerequisite skill for this workflow because cards
always originate from the board card store.

Use it especially when the request says things like:

- create a new card
- add a card for this workflow
- author a card for this dataset
- build a new layout
- introduce a new source and compute chain

## Authoring Discipline

- Start from the smallest viable card that can satisfy the request.
- Choose the card `id` deliberately and keep it stable once introduced.
- Use `card-store-commands` to read nearby example cards and write the new card.
- If the new card should follow requirements or decisions discussed in another card's chat, use `chat-store-commands` to read that chat history first.
- It is acceptable to author `card_data` here because authoring defines the card's initial user-facing data shape.
- Reuse established shapes from nearby cards when they already solve the same problem.
- Add only the fields needed for the requested behavior.
- Keep source, compute, and layout concerns separable when possible.
- Prefer one clear responsibility per card over bundling unrelated behavior.

## Minimum Card Contract

Start from this shape and add only the fields the new card actually needs:

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

## Core Dataflow

- Author cards around one execution order only: `source_defs[]` -> `fetched_sources.*` -> `compute[]` -> `computed_values.*` -> `view` and `provides[]`.
- `source_defs` is configuration, not a runtime namespace. Read fetched data from `fetched_sources.*`.
- `compute[]` reads from `requires.*`, `fetched_sources.*`, and `card_data.*`, then writes to `computed_values.*`.
- `view` and `provides[]` may read from `requires.*`, `fetched_sources.*`, `card_data.*`, and `computed_values.*`.

## Token Wiring

- Use `provides[]` to publish the outputs this card is meant to expose.
- Use `requires[]` only for upstream tokens the card truly needs.
- In expressions, consumed tokens are available at `requires.<key>`.
- For hyphenated required-token names, use JSONata `$lookup(requires, 'my-key')`.
- Do not duplicate a fetch when another card can publish the same data through `provides[]`.

## Source Authoring Rules

- Every source entry must have unique `bindTo` and `outputFile` values within the card.
- Add `source_defs[]` only when the card must fetch or derive source-backed data.
- Fields beyond `bindTo` and `outputFile` are source-specific executor fields. Reuse known working patterns instead of guessing new ones.
- If the card needs projections, declare them under `source_defs[].projections`.
- `projections` may read only from `card_data` and `requires`.
- Do not reference `fetched_sources`, `computed_values`, or `source_defs` inside `projections`.
- If completion should not be blocked by a source, set `optionalForCompletionGating: true` on that source.

## LLM Source Rule

- If the card needs LLM reasoning, author it as a source in `source_defs[]`.
- The source writes its result into `fetched_sources.<bindTo>`, and downstream compute or provides read from there.
- Do not model LLM work as a separate mechanism outside the normal source -> compute -> provides chain.

## View Selection Heuristics

- Default to `table` when the best rendering is not obvious.
- Use `editable-table`, `form`, `filter`, or `todo` only when the user needs to edit state.
- Use `chart` only when there is a clear category/value mapping.
- Use `ref` only when the rendered kind should be chosen dynamically by user state, upstream data, or an LLM-provided `_view` hint.
- For `ref`-driven LLM views, keep `_view.kind` inside the supported renderer set and keep `_view.data` minimal.

## Starter Patterns

- Root source card: source -> `fetched_sources.raw` -> `provides[]` -> simple table view.
- Compute chain card: `requires[]` -> `compute[]` -> `computed_values.*` -> `provides[]` or view.
- Filter pattern: filter/form writes to `card_data`, then downstream cards consume the published token through `requires[]`.
- LLM verdict pattern: source fetches structured verdict JSON, then compute/view/provides consume that result.

## Recommended Workflow

1. Find the closest existing card pattern, if one exists, by using `card-store-commands`.
2. Decide the minimum card contract needed: `card_data`, `requires`, `provides`, `source_defs`, `compute`, and `view`.
3. Lay out the token wiring: what this card requires, what it computes, and what it provides.
4. Create the new card with only the necessary fields and persist it through `card-store-commands`.
5. If the card depends on projections or source inputs, model only the inputs the card actually consumes.
6. If the card computes derived values, add only the compute bindings needed for the requested output.
7. Once the draft card exists, hand off immediately to `ensure-card-correctness`.

## How to Build a New Card

- Start with `id` and the minimal `card_data` needed for the card to make sense.
- Use `card_data` to define the initial user-facing content and structure the card needs at creation time.
- Add `requires[]` only for upstream data the card truly needs.
- Add `provides[]` only for outputs the card is expected to publish.
- Add `source_defs[]` only when the card must fetch or derive external source-backed data.
- Add `compute[]` only for values the card must derive from inputs or fetched sources.
- Add `view` or layout fields only after the card's data contract is clear.
- Keep in mind that a card is complete when all non-optional authored sources have been fetched.

## What Not to Do

- Do not start from a bloated template when a smaller card is enough.
- Do not change existing card ids while authoring a new card.
- Do not copy fields blindly from another card without checking whether this card really needs them.
- Do not bundle multiple unrelated workflows into one card unless the task explicitly requires that.
- Do not treat first-draft authoring as complete until correctness checks pass.
- Do not author a new card through a sequence of `patch` commands.

## Handoff

After authoring, use `ensure-card-correctness` as the required follow-up skill.

Use that skill to:

- validate the new card structure
- probe any authored sources
- evaluate authored compute paths
- run full simulation only if narrower checks are insufficient