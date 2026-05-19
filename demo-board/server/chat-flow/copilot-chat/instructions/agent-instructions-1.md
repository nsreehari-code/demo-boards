# Agent Instructions — Working With Live Boards And Cards

## What This Is

This board runtime no longer uses `board.yaml` as the authoring model.

A **board** is a live runtime surface backed by stores and workers:

- a card store holding card JSON
- a chat store holding per-card conversations
- an artifacts store holding uploaded or attached files
- runtime outputs, scratch, and archive stores
- a board worker task executor that runs `source_defs[]`
- a chat flow that invokes Copilot with card and board context

A **card** is a declarative runtime node. Cards do not call each other directly.
They relate through published and required tokens, and the runtime handles
ordering, retriggers, and downstream propagation.

## Use The Skills First

Use the dedicated skills for operational work and keep this file as the compact
shared reference:

- `card-authoring` for new cards
- `card-editing` for existing cards
- `ensure-card-correctness` for validation, probing, and repair
- `add-remove-card-from-board` for live board membership and retrigger semantics
- `card-store-commands` for stored card CRUD
- `artifacts-store-commands` for uploaded or attached files
- `chat-store-commands` for card chat history

## Board Model At A Glance

Keep only this mental model in mind:

- cards are declarative graph nodes
- `source_defs[] -> fetched_sources.* -> compute[] -> computed_values.* -> view/provides[]`
- `provides[]` publishes tokens, `requires[]` consumes tokens
- downstream recompute is runtime-managed
- a card is complete when all non-optional `source_defs[]` have been fetched

Cards can act as:

- source cards that fetch external or generated data
- compute cards that transform upstream tokens
- UI/state cards that hold editable `card_data`
- coordination cards that publish decisions, readiness, or view hints

## Reactive Workflow Runtime

These boards are not static dashboards. They run as a continuous-event-graph /
reactive graph.

- each card is a workflow node in a living graph
- `provides[]` and `requires[]` define event and data flow between nodes
- when upstream values change, downstream cards are retriggered by the runtime
- when `card_data` changes, any affected projections, sources, computes, and
  views may be recomputed
- when a source completes, the card's fetched state changes and downstream
  consumers may run again
- adding or removing a card changes the live graph itself, not just stored JSON

Think of a board as a continuously running organism:

- cards publish state
- other cards react to that state
- the runtime decides what to recompute and when
- agents can reshape the graph while it is live

This reactive workflow capability is the main power behind yaml-flow boards.
Card authoring is therefore workflow authoring, not just view authoring.

## Card Shape

The stable card contract is still the same:

```json
{
  "id": "my-card",
  "meta": { "title": "Card Title" },
  "requires": [],
  "source_defs": [],
  "compute": [],
  "provides": [],
  "view": {
    "elements": [],
    "layout": {
      "board": { "col": 4, "order": 1 },
      "canvas": { "x": 50, "y": 50, "w": 280, "h": 180 }
    },
    "features": { "refresh": true, "chat": true }
  },
  "card_data": {}
}
```

Use `card-authoring` and `card-editing` for the detailed rules on how to shape
or modify these fields.

## Relationships Between Cards

- `provides[]` publishes named tokens from one card
- `requires[]` consumes those tokens in another card
- cards may form chains, fan-out trees, or UI-to-compute feedback loops
- cards may also publish `_view` hints or other structured outputs for downstream cards

This is the only wiring model. The runtime builds the dependency graph from
token relationships.

## Board Workers And Source Definitions

`source_defs[]` are executed by the board worker task executor. The exact source
kinds are executor-defined and must be discovered from capabilities rather than
guessed.

The current board worker registry includes source kinds such as:

- `urls`
- `copilot`
- `mcp`
- `mock`

Source definitions may be:

- ordinary fetches or lookups
- LLM-backed or agentic sources through `copilot`
- tool-backed sources through `mcp`
- sources that emit both data and dynamic `_view` hints

The executor exposes capability discovery, validation, source preflight, and
fetch execution. Use `ensure-card-correctness` for the operational workflow.

## Agentic Chat And Context

Card chat is agentic and card-scoped, not a generic detached assistant.

The assistant receives rich context including:

- `cardId`
- board setup and runtime roots
- `cardStoreRef`
- `chatStoreRef`
- `artifactsStoreRef`
- `scratchStoreRef`
- resolved chat history and current user text

This means an agent can reason over the current card, inspect nearby cards,
read prior chat, inspect artifacts, and then decide whether to explain data,
edit cards, add cards, remove cards, or suggest dynamic views.

## Dynamic Card Generation And Removal

Agents are allowed to change the live board by operating on cards as data:

- create or update a card in the card store
- upsert that card into the live board
- remove a card from the live board

Use `add-remove-card-from-board` for the runtime meaning of add/remove.

## Dynamic Views Of Known Kinds

Dynamic rendering is allowed, but only through known view kinds.

The current known dynamic kinds are:

- `table`
- `editable-table`
- `chart`
- `metric`
- `list`
- `badge`
- `text`
- `narrative`
- `markdown`
- `form`
- `filter`
- `todo`
- `alert`

Dynamic view selection typically happens through `ref` elements and `_view`
payloads returned by sources. LLM-backed sources may emit `_view` when the card
should render data dynamically, but `_view.kind` must stay inside the known set.

For detailed layout and rendering guidance, use
[agent-instructions-cardlayout.md](c:\Users\sreenaga\ADO\demo-boards\demo-board\agent-instructions-cardlayout.md).

For authoring dynamic-view cards, use `card-authoring`.

---

## Common Card Patterns

Common patterns now live in `card-authoring`.

Use that skill for:

- root source cards
- compute-chain cards
- multi-level token chains
- form and filter propagation patterns
- LLM-backed cards
- user-selectable views
- LLM-suggested `_view` patterns
- cross-card view propagation

---

## Card Design Principles & Layout

See [agent-instructions-cardlayout.md](agent-instructions-cardlayout.md).

---

## Source `customFields` and the Task Executor

Every field on a source entry beyond `bindTo` and `outputFile` is executor-defined.
The runtime passes the source object through unchanged.

Keep only these rules here:

- do not guess source-specific fields
- query the executor when possible
- keep LLM work inside `source_defs[]`
- use `projections` only from `card_data` and `requires`

Use:

- `card-authoring` for source design rules during creation
- `card-editing` for source repair and minimal source changes
- `ensure-card-correctness` for source probing and repair workflow

### source_defs projections

The important rule is unchanged: `projections` may read only from `card_data` and
`requires`, and their resolved values become `_projections` for the executor.

Use `card-authoring` and `ensure-card-correctness` for the detailed authoring and
repair rules around projections.

### Optional source field
- `optionalForCompletionGating: true` marks the source as non-blocking for default task completion.

### Discovering supported source kinds

Rather than guessing which source `customFields` the registered executor supports, query it directly:

```bash
node board-live-cards-cli.js describe-task-executor-capabilities --rg <boardDir>
```

Use this before authoring or repairing a source. If the kind is missing from the
capabilities output, the executor must be extended before the card will work.

## LLM Calls — Use a Source

Keep this rule only:

- all LLM calls belong in `source_defs[]`

Use `card-authoring` for the actual LLM source pattern and `ensure-card-correctness`
for validating or probing those sources.

---

## Validating Cards

Do not use this file as the correctness runbook anymore.

Use `ensure-card-correctness` for:

- validation order
- preflight commands
- source probing
- compute evaluation
- full-cycle simulation
- repair routing

When in doubt about allowed card fields, consult the canonical schema:

- `yaml-flow/schema/live-cards.schema.json`
- `yaml-flow/browser/live-cards.schema.json`

---

## mock.db

A JSON file at the board root keyed by mock name. Used by `"mock": "key"` source_defs. Replace with real task-executor integrations in production.

---
