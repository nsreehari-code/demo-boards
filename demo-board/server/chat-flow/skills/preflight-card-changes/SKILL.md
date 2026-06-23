---
name: preflight-card-changes
description: >
  Validate and repair a candidate card before persisting it live: structure
  validation, lightweight source probe, real source fetch, compute and view
  materialization, and full-cycle simulation. Wraps the `liveboards.preflight.*`
  family.
---

# Preflight Card Changes

## When To Use

Use this skill after creating or editing a card to verify correctness before finishing. Especially valuable when the change touches:

- `source_defs[]`
- `compute[]`
- `requires[]`
- `provides[]`
- `view`
- `card_data` when it affects runtime behavior or validation

For pure layout / view tweaks that pass validation, source probing is usually
not needed.

## Core Correctness Invariants

- Keep the card's execution order coherent:
  `source_defs[]` -> `fetched_sources.*` -> `compute[]` -> `computed_values.*` -> `view` and `provides[]`.
- `source_defs` is configuration, not a runtime namespace. Bindings that read
  fetched data point at `fetched_sources.*`.
- `provides[].ref` resolves from `card_data`, `requires`, `fetched_sources`,
  or `computed_values`.
- `requires[]` is a token-name array. Expressions consume them as
  `requires.<key>` or `$lookup(requires, 'my-key')` for hyphenated names.
- LLM behavior belongs in `source_defs[]`; avoid parallel non-source mechanisms.
- `projections` on a source may read only from `card_data` and `requires`.
- `skip_when` on a source may read only from `card_data` and `requires`; if
  truthy, that source is skipped for that run.

## Validator Expectations

- `id` is present and stable.
- `card_data` is an object.
- `requires[]` is an array of strings when present.
- Each `provides[]` entry has string `bindTo` and `ref` fields.
- Each `compute[]` entry has string `bindTo` and `expr` fields.
- Each `source_defs[]` entry has string `bindTo` and `outputFile`, unique
  within the card.
- `source_defs[].skip_when`, when present, must be a valid JSONata expression
  over `card_data` and `requires` only.
- `view.elements` exists and each element kind is valid.

## MCP Surface

Pass the runtime `boardId` as `board_id` and the runtime `logId` as `log_id`
(opaque; forward unchanged). Add the runtime `cardId` as `card_id` only when
the tool targets an existing live card.

### 1. Validate card structure and semantics

```json
Tool: liveboards.preflight.validate-candidate-card-definition
Arguments: { "board_id": "<boardId>", "log_id": "<logId>", "candidate_card_content": { /* card */ } }
```

Result:

```json
{ "status": "success", "data": { "cardId": "...", "isValid": true, "issues": [] } }
```

### 2. Lightweight source readiness probe

```json
Tool: liveboards.preflight.probe-single-source-in-candidate-card
Arguments: {
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "candidate_card_content": { /* card */ },
  "source_idx": 0,
  "mock_projections": {}
}
```

Use only for readiness / connectivity / configuration probing. Not a proof
the real fetch works.

### 3. Real source fetch preflight (authoritative)

```json
Tool: liveboards.preflight.run-single-source-in-candidate-card
Arguments: {
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "candidate_card_content": { "id": "...", "source_defs": [ /* ... */ ] },
  "source_idx": 0,
  "mock_projections": {}
}
```

Required: `source_idx` (zero-based index in `source_defs[]`). If you
know the source by `bindTo`, resolve it to its index via
`inspect-board-and-card-state` first.

This runs the selected source's real fetch path end to end. It is not a
synthetic dry run. Use this as the authoritative source preflight whenever
the agent must prove the authored source actually works.

### 4. Real source fetch against an existing live card

```json
Tool: liveboards.preflight.run-single-source-in-live-card
Arguments: {
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "card_id": "<cardId>",
  "source_idx": 0,
  "mock_requires": {}
}
```

Use this when the source already exists on the live card and you want to test
that saved definition directly instead of sending `candidate_card_content`.

### 5. Materialize compute, `provides[]`, and `view`

```json
Tool: liveboards.preflight.materialize-candidate-card
Arguments: {
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "candidate_card_content": { /* card */ },
  "mock_fetched_sources": {},
  "mock_requires": {}
}
```

Returns `computed_values`, `provides_outputs`, and `rendered_view` together.

### 6. Full card-cycle simulation

```json
Tool: liveboards.preflight.run-one-cycle-with-candidate-card
Arguments: {
  "board_id": "<boardId>",
  "log_id": "<logId>",
  "candidate_card_content": { /* card */ },
  "mock_requires": {}
}
```

Runs validation, source preflight, compute, and view materialization in one pass. Returns top-level `ok`, `issues` (flattened from all layers), `provides_outputs`, and `rendered_view`. Use only when narrower checks are insufficient or when a cross-layer inconsistency is suspected.

## Choosing What To Run

Run only what the change you made actually needs. There is no fixed order.

- **You changed only `compute[]`, `provides[]`, or `view`** — run
  `liveboards.preflight.materialize-candidate-card`. Source preflight is irrelevant.
- **You changed one `source_defs[]` entry** — run
  `liveboards.preflight.validate-candidate-card-definition` (cheap; catches schema and
  shape mistakes), then `liveboards.preflight.run-single-source-in-candidate-card`
  with the right `source_idx`. Skip the materialize step unless `compute[]`,
  `provides[]`, or `view` also changed.
- **You only adjusted the source author-fields and want a quick sanity check
  before paying the real fetch cost** — use
  `liveboards.preflight.probe-single-source-in-candidate-card`. Don't treat that as
  proof the real fetch works.
- **You changed a saved live card and want to test one source directly on that live card** — use
  `liveboards.preflight.run-single-source-in-live-card`.
- **Validation is failing** — repair the card definition first. Nothing
  downstream is meaningful until validation is clean.
- **Targeted checks pass but the card still looks wrong** — run
  `liveboards.preflight.run-one-cycle-with-candidate-card` to surface cross-layer
  inconsistencies. Don't reach for this first.
- **A repair changes the card itself** — persist through
  `manage-cards-on-live-board` (`upsert-card`) before re-checking.

The invariant, not the order: **when you stop, validation is clean and every
layer you actually touched has passed its own check.** How you reach that
state is your call.

## How To Interpret Failures

- Validate failures → schema, JSONata, namespace, or unsupported source fields.
- Probe failures → readiness / connectivity / configuration in the lightweight
  path.
- Run-single-source failures → projection shape, missing required source
  fields, or runtime connectivity / config in the real fetch.
- Materialize failures → broken compute expressions, wrong mock input shape,
  or `provides[].ref` / `view` bindings that don't line up with runtime
  namespaces.
- Run-one-cycle failures → multiple layers inconsistent; route back via the
  returned validation / source / compute / output sections.

Common routing:

- Invalid `provides[].ref` → fix namespace or upstream field.
- Wrong-namespace compute expression → fix the expression before changing mocks.
- Source probe failing on projections → fix the `projections` expressions or
  the source-specific fields that consume them.
- Validation failing on duplicate `bindTo` / `outputFile` → fix the card
  contract first; probing and compute come later.

## Payload Construction Rules

- Required top-level fields must be present even when their values are empty
  objects.
- Use realistic field names but keep payloads as small as possible.
- Preserve the actual `id`, `bindTo`, `outputFile`, and compute expressions
  from the card under repair.

## Scope Discipline

- Focus on the one card and the specific source, compute path, or layer you changed.
- Use minimal mocks, not full board snapshots.
- Escalate to full-cycle only when narrower checks are insufficient.

## Related Skills

- `manage-cards-on-live-board` — when a check fails and the card itself needs
  changing.
- `discover-board-capabilities` — when the failure is really about which
  source kinds or fields are valid.
- `provide-final-reply-to-user` — when the task ends with a user-visible
  answer.
