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
- `lore-commands` for durable board-level and user-level lore

Treat the `*-commands` skills as the authoritative command surfaces for their
respective stores and runtime operations.

Treat `ensure-card-correctness` as the authoritative correctness skill for any
material card change. A card create/edit/repair task is not complete until the
relevant `ensure-card-correctness` checks have passed for the changed card.

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
fetch execution. Use `ensure-card-correctness` for the authoritative validation,
source-preflight, compute-check, and repair workflow.

## Agentic Chat And Context

Card chat is agentic and card-scoped, not a generic detached assistant.

The user is usually looking at a live visual board while chatting. That visible
board context matters.

Assume the user's chat is grounded in what they can already see on the board,
including:

- card titles, layout, and visual grouping on the board
- card view content rendered through the supported view kinds
- published data objects and computed values visible through runtime-backed cards
- overall board runtime status and whether cards look complete, blocked, failed, or stale
- prior chat turns and any uploaded or attached artifacts tied to the card
- and the board layout of the cards in an intuitive way for users

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

When the visible board context or prior interaction context matters, reconstruct
it through the command skills instead of guessing:

- use `card-store-commands` to inspect stored card definitions and nearby card context
- use `cards-runtime-status` to inspect board status, published data objects, and computed values
- use `chat-store-commands` to inspect the current card chat or relevant nearby card chats
- use `artifacts-store-commands` to inspect uploaded or attached artifacts

Treat these sources together as the main way to recover the user's working
context when the current request depends on what they are seeing on the board.

## Durable Lore

Some knowledge should accumulate beyond a single card or one immediate task.

Treat lore as durable board-level and user-level memory for confirmed knowledge
that should remain useful across cards, chats, and future sessions.

Typical lore candidates include:

- standing user preferences or recurring instructions
- board-level conventions and stable operating assumptions
- identity resolvers for recurring names, entities, or accounts
- durable decisions that resolve recurring ambiguity

Do not treat transient card state, one-off task notes, or extracted record data
as lore.

Use `lore-commands` when a task needs lore commands to inspect or update that durable memory.

## Lore Maintenance Workflow

Treat durable lore review as a workflow phase, not as passive background behavior.

For tasks that uncover confirmed durable user, board, identity, or decision
knowledge:

1. complete the main card/chat task first
2. identify any durable lore candidates from the resolved task outcome
3. delegate to `lore-keeper` agent to inspect, deduplicate, and update lore
4. treat the task as complete only after `lore-keeper` agent either updates lore or
  returns that no durable lore change is needed

`lore-keeper` agent  owns updates to the workspace lore knowledge base. Do not update
lore directly from the main agent when `lore-keeper` agent is available.

Typical lore-keeper delegation triggers include:

- the user corrected a recurring preference or standing instruction
- a recurring identity, entity, account, or document-name mapping was resolved
- a board-level convention or stable operating assumption was confirmed
- a durable decision removed recurring ambiguity for future tasks
- prior chat or artifacts established reusable context that should persist across cards or sessions

If none of these durable-memory conditions are met, ignore lore updates.

## Dynamic Card Generation And Removal

Agents are allowed to change the live board by operating on cards as data:

- create or update a card in the card store
- upsert that card into the live board
- remove a card from the live board

Use `add-remove-card-from-board` for the board live-card commands that add, upsert, restart, or remove cards.

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

Always route card validation and repair through `ensure-card-correctness`.

If you create, edit, or repair a card and the change can affect behavior,
assume `ensure-card-correctness` is required before treating the task as done.
This is especially important for changes to:

- `source_defs[]`
- `compute[]`
- `requires[]`
- `provides[]`
- `view`
- `card_data` when it affects runtime behavior or validation

Use `ensure-card-correctness` for:

- validation order
- preflight commands
- source probing
- compute evaluation
- full-cycle simulation
- repair routing

Use narrower card-store or board-runtime commands to inspect or persist state,
but use `ensure-card-correctness` to prove that the changed card is valid and
behaves correctly.

When in doubt about allowed card fields, consult the canonical schema:

- `yaml-flow/schema/live-cards.schema.json`
- `yaml-flow/browser/live-cards.schema.json`

---

## mock.db

A JSON file at the board root keyed by mock name. Used by `"mock": "key"` source_defs. Replace with real task-executor integrations in production.

---
