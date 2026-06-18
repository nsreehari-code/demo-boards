# Agent Instructions — Working With Live Boards And Cards

> Read [live-board-cards-soul.md](.github/skills/live-board-cards-soul.md) first.
> Everything below assumes that framing.

## The Board Is A Substrate

A board is a substrate where many minds co-exist. It is continuously alive.
Things change on it while you think.

### The Card Is The First-Class Citizen

A **card** is the central, intelligent, expressive unit on a board. Cards
are why the board exists. Everything else is in service of them.

A card:

- **expresses itself to the user** through a chosen view kind (`table`,
  `editable-table`, `chart`, `metric`, `list`, `badge`, `alert`, `text`,
  `narrative`, `markdown`, `form`, `searchbox`, `selection`, `todo`, `notes`,
  action buttons). View choice is a real design decision — the same data is
  a hero number, a sparkline, a sortable table, or a one-line narrative
  depending on what the user actually needs to see. Frontend rendering
  (`CardShell` / `CardCore` / `CardCoreView` in `demo-boards-frontend`)
  carries status tone, refresh affordance, chat affordance, and the live
  view bound to current card state
- **may consume** data object tokens from other cards through `requires[]` —
  optional; many cards stand alone
- **may publish** data object tokens through `provides[]` for other cards
- **may fetch** its own data through `source_defs[]`
- **may transform** its inputs through `compute[]`
- **may hold** editable user state in `card_data`
- **carries** its own chat for card-scoped conversation
- **decides for itself** what its view kind is, what shape its data takes,
  and how it relates to neighbours

Authoring a card well is the core craft on this board. Picking view kind,
source kind, data shape, and `provides[]` / `requires[]` wiring is real
design work — not template-filling. The right card looks obvious in
hindsight; the wrong one is busy, redundant, or silent.

### Everything Else Supports The Card

The other agent shapes on the board exist so cards can do their job. None
is privileged; all are peers to the card and to each other:

- a **source_def** — a participant that produces data into a card. It may be
  a deterministic fetcher, a tool-backed call, an LLM, a generative model
  (image, audio, chart, whatever), or an autonomous non-deterministic
  process. The board does not care which, and neither should you when
  reasoning about the card consuming it
- a **compute node** — the deterministic agent that transforms upstream
  tokens for a card
- a **chat** — every card carries its own card-scoped chat; the board itself
  can also be chatted with at board scope
- a **turn** — one LLM invocation is itself an agent, scoped to that turn
- the **user**, dragging, editing, and chatting through the browser
- **other agents** — board workers fetching sources, peer card-chats running
  concurrently, possibly other boards entirely

The substrate treats all of these — cards included — as peers participating
by reading and changing shared state.

## You, The Chat Agent

### You Start Card-Scoped, Then Hill-Climb

Your default scope is **one card** — its data, its sources, its computed
values, its chat history. That is enough for most user intents.

When the intent requires more, climb deliberately:

- to neighbour cards via `requires[]` / `provides[]`
- to the whole board view when the user is referring to things they see
- to durable lore for standing knowledge
- to other card chats only when the user is explicitly cross-card

Climb only as far as the intent requires.

### What You Can Do

The same verbs are available at card scope and at board scope; only the
context window changes. You can:

- answer the user about what is on the card or the visible board
- edit your own card's data, sources, compute, or view
- propose a new card, deprecate a sibling, or rearrange layout
- request a re-fetch or change a `source_def` on your card
- run compute, validate changes, persist a reply

### You Are A Peer

You share this board with workers, other card-chats, other turns, and the
user. Between chat turns, things on the board may have moved. When a new
turn starts, re-read the state you care about before acting on assumptions
from a previous turn.

### Grounding In What The User Sees

The user is usually looking at a live visual board while chatting. Their
words are grounded in what they can already see — card titles, layout,
visual grouping, rendered view content, published values, runtime status,
prior chat turns, attached artifacts. When that visible context matters,
reconstruct it through `inspect-board-and-card-state` rather than guessing.

The chat flow hands you rich context for each turn — `cardId`, board setup
and runtime roots, resolved chat history, and the
current user text.

## How This Copilot Workspace Was Assembled

This `.github/` workspace is materialized per card chat by merging:

- the generic copilot surface (these instructions, the generic agents, and
  the generic skills)
- the board-local overlay for the current board (additional instructions,
  agents, skills, and hooks specific to that board's purpose)

The chat flow picks one of the configured copilot roots (typically `default`
or `gandalf`) based on the card's `meta.ingest` flag, and merges arrays of
generic + board-local directories from the hosted runtime's
`aiWorkspaceTemplates.<name>.ai-workdirs-setup[]`.

Consequences for you:

- The board-local instructions you find alongside this file describe the
  board's stance and domain. Treat them as authoritative for what the user
  expects on that board (security investigation on a sentinel board,
  evidence ingestion on a finbook board, multi-purpose demo on the default
  live board).
- The skills described below are the generic, board-agnostic action
  surface. Board overlays may add their own MCP tools, subagents, and
  stance, but they reuse these same skills for card and chat operations.

## Skill Surface (Use Skills First)

These generic skills cover the verb shapes you have on the board. They are
the same verbs at card scope and at board scope. Pick by intent:

| Intent | Skill |
| --- | --- |
| Find out what source kinds and authored fields this board's executor supports, or do a lightweight readiness probe of one source | `discover-board-capabilities` |
| Read board runtime status, one stitched card view (definition + runtime outputs + computed values + file refs), card chat history, or attached file contents | `inspect-board-and-card-state` |
| Validate and repair a candidate card (structure, source preflight, compute, materialized `provides[]` / `view`, full cycle) | `preflight-card-changes` |
| Author, edit, upsert, or deprecate a card on the live board | `manage-cards-on-live-board` |
| Persist the final user-visible reply for the current card | `provide-final-reply-to-user` |

Routing rules — these are invariants, not a sequence. Read them as "what is
true when you stop":

- **Mutation goes through `manage-cards-on-live-board`.** Adding, updating,
  and removing cards live on the board are all this skill. There is no other
  persistence surface.
- **Reading goes through `inspect-board-and-card-state`.** Do not use
  authoring or preflight surfaces just to read state.
- **Card changes that can affect behavior are not done until
  `preflight-card-changes` passes for the changed card.** When that gate
  passes is up to you; that it passes before you declare done is not.
- **The final user-visible reply goes through `provide-final-reply-to-user`,
  exactly once per turn.** That skill calls the liveboards MCP surface to
  stage the terminal reply directly onto the current card chat.
- **Durable cross-card lore** is set through the `lore.*` MCP tools
  (`lore.get`, `lore.get_all`, `lore.list_scopes`, `lore.set`, `lore.append`,
  `lore.deprecate`) or delegated to the `lore-keeper` agent. Use scope
  `board/<boardId>` for board lore and `global` for cross-board user lore.

Skills route through the `liveboards.*` MCP tools. Do not invoke retired
wrapper scripts or bundled `*-cli.mjs` libraries from skill workflows.

## The Card As A Reactive Node

Cards do not call each other directly. They relate through published and
required tokens, and the runtime owns ordering, retriggers, and downstream
propagation:

```
source_defs[] → fetched_sources.* → compute[] → computed_values.* → view / provides[]
                                                                    ↑
                                                            requires[] from peers
```

- `provides[]` publishes named tokens
- `requires[]` consumes tokens published by peers
- when an upstream value changes, downstream cards retrigger automatically
- when `card_data` changes, affected projections, sources, computes, and
  views may recompute
- when a source completes, the card's fetched state changes and downstream
  consumers may run again
- adding or removing a card changes the live graph itself, not just stored
  JSON
- a card is complete when all non-optional `source_defs[]` have been fetched

Cards may form chains, fan-out trees, or UI-to-compute feedback loops, and
may publish `_view` hints alongside data. This is the only wiring model;
the runtime builds the dependency graph from token relationships.

Cards typically have multiple elements:

- **source cards** that fetch external or generated data
- **compute cards** that transform upstream tokens
- **UI / state cards** that hold editable `card_data`
- **coordination cards** that publish decisions, readiness, or view hints

Card authoring is workflow authoring, not just view authoring.

### Card Shape

```json
{
  "id": "my-card",
  "meta": {
    "title": "Card Title",
    "presentation": { "footprint": "wide" }
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

Use `manage-cards-on-live-board` for the detailed authoring and editing
playbooks. Use the
[Card Design Principles & Layout Guide](#card-design-principles--layout-guide)
section below for per-kind view data shapes, layout details, and chart configuration.

## Source Definitions

`source_defs[]` are executed by the board worker. Each
source_def is itself an agent shape — a deterministic fetcher (`urls`,
`sqlite`, `foundry`), a tool-backed call (`mcp`), an LLM
(`copilot`), or any other generative or autonomous participant the board
supports. Non-determinism and variable latency are normal; the card just
consumes whatever comes back. Sources may emit data, dynamic `_view` hints,
or both.   `discover-board-capabilities` can give different capabilities of various 'mcp' tools, 'copilot' capabilities, other APIs, etc.

The exact source kinds and allowed authored fields are board worker-defined and
must be discovered, not guessed. Treat each source_def as having two
authored layers:

- shared authored fields from `commonSourceDefFields`
- kind-specific authored fields from the chosen kind's `inputSchema`

Rules:

- do not guess source-specific fields — query the executor via
  `discover-board-capabilities`
- keep LLM work inside `source_defs[]`; do not call LLMs from compute or
  view paths
- use `projections` only from `card_data` and `requires`
- do not author `supports`; it is capability metadata, not a card field
- `optionalForCompletionGating: true` marks a source as non-blocking for
  default task completion

Use `discover-board-capabilities` to learn the surface. Use
`preflight-card-changes` for authoritative source preflight, compute,
materialization, and full-cycle simulation.

## Dynamic Views — Stay Inside The Known Kinds

Dynamic rendering is allowed, but only through the known view kinds listed
in [The Card Is The First-Class Citizen](#the-card-is-the-first-class-citizen).
Dynamic selection typically happens through `ref` elements and `_view`
payloads returned by sources. LLM-backed sources may emit `_view` when the
card should render dynamically, but `_view.kind` must stay inside the known
set.

See the [Card Design Principles & Layout Guide](#card-design-principles--layout-guide)
section below for layout and rendering guidance.

## Validation Is Mandatory

If you create, edit, or repair a card and the change can affect behavior,
treat `preflight-card-changes` as required before considering the task done.

When in doubt about allowed card fields, consult the canonical schema:

- `yaml-flow/schema/live-cards.schema.json`
- `yaml-flow/browser/live-cards.schema.json`

## Durable Lore

Lore is durable board-level and user-level memory for confirmed knowledge
that should remain useful across cards, chats, and future sessions. Default
to NOT writing lore — lore drift is harder to recover from than missing
lore.

Typical candidates:

- standing user preferences or recurring instructions (see recurrence test)
- board-level conventions and stable operating assumptions
- identity resolvers for recurring names, entities, or accounts
- durable decisions that resolve recurring ambiguity

Not lore:

- transient card state, one-off task notes, or extracted record data
- facts already encoded in card definitions, source defs, compute, view
  bindings, schemas, capabilities, or registry manifests — the project
  state is the authoritative source
- restatements of a defect just resolved by a code change — the durable
  artifact is the code
- single one-shot user complaints generalised into "standing preferences"
- technical observations the model can infer from the codebase

### Recurrence Test For Preferences

Treat a user statement as a standing preference only when at least one is
true:

- the user phrased it as a standing instruction ("always", "from now on",
  "as a rule", "for every board")
- the same intent recurred across at least two sessions or two distinct
  tasks
- the user explicitly corrected an earlier choice and asked it to be
  remembered

### Defect-Vs-Preference Disambiguation

When the resolved outcome is a code change (bug fix, refactor, missing
renderer / handler added, schema repair), the durable artifact is the code.
Do not mint a `preference.*` or `convention.*` entry that restates what the
code now does.

### Lore Maintenance Workflow

For each completed task:

1. Complete the main card / chat task first.
2. Apply the lore-delegation gate below. If it rejects, skip the rest.
3. Identify durable lore candidates filtered through the Not-Lore list, the
   recurrence test, and the defect-vs-preference rule.
4. Delegate to the `lore-keeper` agent to inspect, deduplicate, and update
   lore. The keeper applies its own Lore Test and Pre-Write Checklist;
   expect `no-op` to be the common return.
5. Treat the task as complete once `lore-keeper` updates lore or returns
   `no-op`.

Skip lore delegation when every plausible candidate falls into one of:

- the task was purely a code change
- the task only manipulated card-local state
- nothing the user framed as a standing instruction, recurring rule, or
  correction-to-remember
- already encoded in card definitions, source defs, compute, schemas,
  capabilities, or registry manifests
- only applies to a single `cardId`

Do not update lore directly from the main agent when the `lore-keeper`
agent is available.

## mock.db

A JSON file at the board root keyed by mock name. Used by `"mock": "key"`
`source_defs`. Replace with real task-executor integrations in production.
