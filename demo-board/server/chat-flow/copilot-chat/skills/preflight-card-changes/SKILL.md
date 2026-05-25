---
name: preflight-card-changes
description: >
  Validate and repair a candidate card before persisting it live: structure
  validation, lightweight source probe, real source fetch, compute and view
  materialization, and full-cycle simulation. Wraps the `preflight-*` family.
---

# Preflight Card Changes

## When To Use

Use this skill whenever you create or edit a board card and need a reliable
correctness loop before treating the card as done.

This is the authoritative correctness skill. A card create / edit / repair task
is not complete until the relevant checks here have passed for the changed
card.

Especially required when the change touches:

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
  fetched data must point at `fetched_sources.*`.
- `provides[].ref` must resolve from `card_data`, `requires`, `fetched_sources`,
  or `computed_values`.
- `requires[]` is a token-name array. Expressions consume them as
  `requires.<key>` or `$lookup(requires, 'my-key')` for hyphenated names.
- LLM behavior belongs in `source_defs[]`; do not repair by inventing a
  parallel non-source mechanism.
- `projections` on a source may read only from `card_data` and `requires`.

## Validator Expectations

- `id` is present and stable.
- `card_data` is an object.
- `requires[]` is an array of strings when present.
- Each `provides[]` entry has string `bindTo` and `ref` fields.
- Each `compute[]` entry has string `bindTo` and `expr` fields.
- Each `source_defs[]` entry has string `bindTo` and `outputFile`, unique
  within the card.
- `view.elements` exists and each element kind is valid.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in
`.github/scripts`. All commands are payload-driven and read JSON from stdin
unless noted.

### 1. Validate card structure and semantics

```bash
cat payload.json | node ./.github/scripts/preflight-validate-candidate-card-definition.js
```

Payload:

```json
{ "candidate_card_content": { /* card */ } }
```

Result:

```json
{ "status": "success", "data": { "cardId": "...", "isValid": true, "issues": [] } }
```

### 2. Lightweight source readiness probe

```bash
cat payload.json | node ./.github/scripts/preflight-probe-single-source-in-candidate-card.js --source-idx 0
```

Use only for readiness / connectivity / configuration probing. Not a proof
the real fetch works.

### 3. Real source fetch preflight (authoritative)

```bash
cat payload.json | node ./.github/scripts/preflight-run-single-source-in-candidate-card.js --source-idx 0
```

Payload:

```json
{
  "candidate_card_content": { "id": "...", "source_defs": [ /* ... */ ] },
  "mock_projections": { /* may be empty */ }
}
```

Required: `--source-idx <n>` (zero-based index in `source_defs[]`). If you
know the source by `bindTo`, resolve it to its index via
`inspect-board-and-card-state` first.

This runs the selected source's real fetch path end to end. It is not a
synthetic dry run. Use this as the authoritative source preflight whenever
the agent must prove the authored source actually works.

### 4. Materialize compute, `provides[]`, and `view`

```bash
cat payload.json | node ./.github/scripts/preflight-materialize-candidate-card.js
```

Payload:

```json
{
  "candidate_card_content": { /* card */ },
  "mock_fetched_sources": { /* may be empty */ },
  "mock_requires": { /* may be empty */ }
}
```

Returns `computed_values`, `provided_outputs`, and `view_model` together.

### 5. Full card-cycle simulation

```bash
cat payload.json | node ./.github/scripts/preflight-run-one-cycle-with-candidate-card.js --base-ref <board-ref>
```

Payload:

```json
{
  "candidate_card_content": { /* card */ },
  "mock_requires": { /* may be empty */ }
}
```

Runs validation, projection resolution, source preflight, compute, materialized
`provides[]`, and `view_model` in one pass. Returns `validation`,
`projection_errors`, `computed_values`, `compute_errors`, `provided_outputs`,
`view_model`, and top-level `ok`. Use only when narrower checks are insufficient
or when a cross-layer inconsistency is suspected.

## Choosing What To Run

Run only what the change you made actually needs. There is no fixed order.

- **You changed only `compute[]`, `provides[]`, or `view`** — run
  `preflight-materialize-candidate-card.js`. Source preflight is irrelevant.
- **You changed one `source_defs[]` entry** — run
  `preflight-validate-candidate-card-definition.js` (cheap; catches schema and
  shape mistakes), then `preflight-run-single-source-in-candidate-card.js`
  with the right `--source-idx`. Skip the materialize step unless `compute[]`,
  `provides[]`, or `view` also changed.
- **You only adjusted the source author-fields and want a quick sanity check
  before paying the real fetch cost** — use
  `preflight-probe-single-source-in-candidate-card.js`. Don't treat that as
  proof the real fetch works.
- **Validation is failing** — repair the card definition first. Nothing
  downstream is meaningful until validation is clean.
- **Targeted checks pass but the card still looks wrong** — run
  `preflight-run-one-cycle-with-candidate-card.js` to surface cross-layer
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

- Validation only: `{ "candidate_card_content": <card> }`.
- Probing a source: `{ "candidate_card_content": <card>, "mock_projections": { /* ... */ } }`.
- Evaluating compute, `provides[]`, or `view`:
  `{ "candidate_card_content": <card>, "mock_fetched_sources": { /* ... */ }, "mock_requires": { /* ... */ } }`.
- Simulating one cycle: `{ "candidate_card_content": <card>, "mock_requires": { /* ... */ } }`
  with `preflight-run-one-cycle-with-candidate-card.js --base-ref <board-ref>`.
- Required top-level fields must be present even when their values are empty
  objects.
- Use realistic field names but keep payloads as small as possible.
- Preserve the actual `id`, `bindTo`, `outputFile`, and compute expressions
  from the card under repair.

## Scope Discipline

- Start with the one card you changed.
- Never change the `id` of a card.
- Start with the one source index or compute path you changed.
- Use minimal mocks, not full board snapshots.
- Escalate to full-cycle only when narrower checks are insufficient.
- Repair the card itself, not unrelated board infrastructure.

## Related Skills

These are not next steps in a pipeline — reach for them when the intent
shifts:

- `manage-cards-on-live-board` — when a check fails and the card itself needs
  changing.
- `discover-board-capabilities` — when the failure is really about which
  source kinds or fields are valid.
- `provide-final-reply-to-user` — when the task ends with a user-visible
  answer.
