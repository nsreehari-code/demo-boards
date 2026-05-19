# Copilot Instructions — yaml-flow Boards & Cards

Use this file as the high-level authoring guide. Keep operational command detail in the shared skills.

## Primary Workflow

- Cards always come from the board card store. Use `card-store-commands` to load and persist them.
- Use `card-editing` for existing cards and `card-authoring` for new cards.
- If the task involves uploaded or attached files, inspect them through `artifacts-store-commands` after discovering them from `card_data.files`.
- If the task depends on another card's prior discussion, use `chat-store-commands` to read that card's chat history.
- After creating or editing a card, always hand off to `ensure-card-correctness`.

## Core Model

- Cards are declarative. Do not design imperative card-to-card calls.
- Data flows in one order only:
  1. `source_defs[]` -> `fetched_sources.*`
  2. `compute[]` -> `computed_values.*`
  3. `view` and `provides[]`
- `source_defs` is configuration, not a runtime namespace. Read fetched data from `fetched_sources.*`.
- Valid runtime namespaces are `card_data`, `requires`, `fetched_sources`, and `computed_values`.
- Use `provides[]` and `requires[]` to connect cards. Do not duplicate a fetch when another card already provides the needed data.
- For hyphenated `requires` keys, use JSONata `$lookup(requires, 'my-key')`.

## Minimal Card Shape

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

Only add the fields the card actually needs.

## Card Design Rules

- Cards are not pages. Think note-sized, not dashboard-sized.
- Give each card one responsibility. If the title needs "and", split it.
- Keep primary content immediately visible; do not stack many metrics above the real payload.
- Use at most one hero `metric`. Collapse secondary summary values into compact text.
- Avoid redundancy across cards. Aggregations are fine when they add new information.
- Separate input from output. Keep editable cards lean and push heavy compute/display into downstream cards.
- Prefer sparse, readable cards over dense cards that require study.

## Layout Rules

- `board.col` uses the Bootstrap 12-column scale: `3`, `4`, `6`, `8`, `12`.
- `board.order` controls vertical ordering in board view.
- `canvas.h` must be tall enough for the rendered content. Avoid in-card scrollbars by sizing generously.

## Editing And Authoring Guardrails

- Do not change the `id` of an existing card.
- When editing, keep the change as narrow as possible and preserve unaffected behavior.
- Treat `card_data` as protected user-managed content during routine edits. Only fix syntax, formatting, or broken structure unless the task explicitly calls for content changes.
- When authoring a new card, it is acceptable to define the initial `card_data` shape.
- Reuse nearby working shapes before inventing a new one.

## Source Rules

- Every source entry must have unique `bindTo` and `outputFile` values within the card.
- Fields beyond `bindTo` and `outputFile` are executor-defined. Do not guess unsupported source kinds or field names.
- Prefer existing working card patterns for source definitions.
- `projections` may read only from `card_data` and `requires`.
- Do not reference `fetched_sources`, `computed_values`, or `source_defs` inside `projections`.
- If an LLM call is needed, model it as a source in `source_defs[]`, not as a separate mechanism.

## View Rules

- Choose the simplest element kind that fits the data.
- Use `table` as the default fallback when no stronger rendering is justified.
- Use `editable-table`, `form`, `filter`, or `todo` only when the user must edit state.
- When using `kind: "ref"`, keep the resolved `_view.kind` inside the allowed renderer set:
  `table`, `editable-table`, `chart`, `metric`, `list`, `badge`, `text`, `narrative`, `markdown`, `form`, `filter`, `todo`, `alert`.
- Keep `_view.data` minimal.
- Use `editable-table` only when the payload should write back to a `card_data.*` path.
- Use `chart` only when there is a clear label/value mapping.

Recommended `_view` shape:

```json
{
  "<data_key>": [],
  "_view": {
    "kind": "table",
    "data": {
      "columns": ["field1", "field2"]
    }
  }
}
```

## Validation

- Do not treat a card as done until correctness checks pass.
- Use `ensure-card-correctness` for validation, source probing, compute evaluation, and simulation.
- If a source or compute path changes, validate that same slice before widening scope.

## Board Notes

- A board is a `board.yaml` plus its card set.
- `connects` entries and source-specific fields are passed through to the task executor and are not a general schema contract for cards.
- Keep board-level and card-level concerns separate: board config describes integrations; cards describe dataflow and UI.