---
name: ensure-card-correctness
description: >
  Validate and repair a board card end to end using the current staged wrapper
  commands. Use after creating or editing a card definition, especially when the
  change touches `source_defs`, `compute`, `card_data`, `requires`, `provides`, or `card layout`.
---

# Ensure Card Correctness

## When to Use

Use this skill whenever you create or edit a board card and need a reliable
correctness loop before treating the card as done.

`card-store-commands` is a prerequisite skill for this workflow because cards
always originate from the board card store.

Use it especially when the change affects:

- `source_defs[]`
- `compute[]`
- `requires[]`
- `card_data`
- `provides[]`
- `view`

This skill is the command reference for the current staged wrapper commands.
Use the commands in this file as the authoritative validation and repair workflow.

If a validation or repair task depends on decisions captured in another card's discussion, use `chat-store-commands` to read that chat history before making further changes.

Use the returned card object as the basis for validation, source probe payloads,
compute payloads, and simulation payloads. If a repair changes the stored card,
use `card-store-commands` to write the repaired full card back before re-running
correctness checks.

## Core Correctness Invariants

- Keep the card's execution order coherent: `source_defs[]` -> `fetched_sources.*` -> `compute[]` -> `computed_values.*` -> `view` and `provides[]`.
- `source_defs` is configuration, not a runtime namespace. If a binding is meant to read fetched data, it should point at `fetched_sources.*`.
- `provides[].ref` must point at a valid runtime namespace path.
- `requires[]` is a token-name array. Expressions that consume required tokens should read `requires.<key>` or use JSONata `$lookup(requires, 'my-key')` for hyphenated keys.
- LLM behavior belongs in `source_defs[]`; do not repair a card by inventing a parallel non-source mechanism.

## Validator Expectations

- `id` must be present and stable.
- `card_data` must remain an object.
- `requires[]` must be an array of strings when present.
- `provides[]` entries must have string `bindTo` and `ref` fields.
- `provides[].ref` must start from `card_data`, `requires`, `fetched_sources`, or `computed_values`.
- `compute[]` entries must have string `bindTo` and `expr` fields.
- `source_defs[]` entries must have string `bindTo` and `outputFile` fields, and those values must be unique within the card.
- `view.elements` must exist and each element kind must be valid.

## Source Repair Constraints

- If a source uses `projections`, those expressions may read only from `card_data` and `requires`.
- Do not introduce `fetched_sources`, `computed_values`, or `source_defs` into `projections` while repairing a card.
- If a source repair changes projections, build the smallest `mock_projections` payload that exercises that same source.
- Treat source-specific fields beyond the shared source fields as kind-specific; use `card-source-defs` when you need to confirm the valid source fields instead of guessing broad new shapes.

Use `card-source-defs` when the repair question is specifically about supported
source kinds, valid source fields, or which source probe to run.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`:

```bash
node ./.github/scripts/preflight-validate-candidate-card-definition.js
```

The commands below are payload-driven and read JSON from stdin.

### 1. Validate card structure and semantics

```bash
cat payload.json | node ./.github/scripts/preflight-validate-candidate-card-definition.js
```

Actual payload contract:

- stdin must be a JSON object
- required top-level field is `candidate_card_content`
- `candidate_card_content` must be a JSON object

Expected result shape:

```json
{
  "status": "success",
  "data": {
    "cardId": "...",
    "isValid": true,
    "issues": []
  }
}
```

### 2. Run one source actual fetch preflight

```bash
cat payload.json | node ./.github/scripts/preflight-run-single-source-in-candidate-card.js --source-idx 0
```

The stdin payload should be:

```json
{
  "candidate_card_content": { "id": "...", "source_defs": [] },
  "mock_projections": {}
}
```

Actual payload contract:

- stdin must be a JSON object
- required top-level fields are `candidate_card_content` and `mock_projections`
- each required field must be a JSON object
- the command requires `--source-idx <n>`

Required argument:

- `--source-idx <n>`: zero-based source index in `source_defs[]`

Mental model:

- `preflight-run-single-source-in-candidate-card.js` is the authoritative real-flow preflight.
- It runs the selected source's real fetch path end to end for the current `source_def`.
- Use it to verify that the chosen fetch path actually works with the current source definition and projections.
- It is not a synthetic dry run, mock-only check, or metadata-only validation step.
- `preflight-probe-single-source-in-candidate-card.js` is the lightweight variant and is useful only for quick readiness, connectivity, or configuration probing.

Expected result includes fields like:

- `bindTo`
- `reachable`
- `latencyMs`
- `note`

### 2a. Run one source lightweight probe

```bash
cat payload.json | node ./.github/scripts/preflight-probe-single-source-in-candidate-card.js --source-idx 0
```

Use this only when you need a lightweight readiness probe rather than proof that the full source flow works.

Expected result includes fields like:

- `bindTo`
- `reachable`
- `latencyMs`
- `note`

### 3. Materialize `provides[]` and `view` from compute output

Use the staged helper when you need the authored card's `provided_outputs` and
resolved `view_model`, not just raw `computed_values`.

```bash
cat payload.json | node ./.github/scripts/preflight-materialize-candidate-card.js
```

Payload contract:

- stdin must be a JSON object
- required top-level fields are `candidate_card_content`, `mock_fetched_sources`, and `mock_requires`
- each required field must be a JSON object
- the wrapper accepts stdin only

Expected result includes:

- `computed_values`
- `provided_outputs`
- `view_model`

### 4. Simulate the full card cycle

```bash
cat payload.json | node ./.github/scripts/preflight-run-one-cycle-with-candidate-card.js --base-ref <board-ref>
```

Use this when the card couples validation, projections, sources, and compute and
you want a combined result in one pass, including materialized `provides[]` and
`view`.

Expected result includes:

- `validation`
- `projection_errors`
- `computed_values`
- `compute_errors`
- `provided_outputs`
- `view_model`
- top-level `ok`

Actual payload contract:

- stdin must be a JSON object
- required top-level fields are `candidate_card_content` and `mock_requires`
- each required field must be a JSON object
- empty objects are allowed for `mock_requires`
- the wrapper accepts stdin only
- source preflight still runs against the card's `source_defs[]`
- `provided_outputs` and `view_model` are materialized from the card plus `mock_requires` and returned `computed_values`
- `fetched_sources.*` bindings in `provides[]` or `view` should be checked with source preflight or focused materialization when they matter

## Repair Workflow

Follow this exact order.

1. Run `preflight-validate-candidate-card-definition.js` first.
2. If it reports issues, repair the card definition first. Do not move to probing or compute until validation is clean.
3. If the changed card has `source_defs[]`, build the smallest payload that exercises only the touched source and run `preflight-run-single-source-in-candidate-card.js` for each changed source index.
4. If the changed card has `compute[]`, `provides[]`, or `view`, build the smallest representative mocks and run `preflight-materialize-candidate-card.js`.
5. Use `preflight-materialize-candidate-card.js` to verify `computed_values`, `provided_outputs`, and `view_model` together from one payload.
6. If targeted checks are individually clean but the card is still suspicious, run `preflight-run-one-cycle-with-candidate-card.js` to surface cross-layer inconsistencies and verify materialized `provides[]` and `view` in the same pass.
7. Repeat until validation is clean and every touched source, compute path, and materialized `provides[]` or `view` path has a passing result.

## Preferred Scope Discipline

- Start with the one card you changed.
- Never change the `id` of a card.
- Start with the one source index or compute path you changed.
- Use minimal mocks, not full board snapshots.
- Escalate to `preflight-run-one-cycle-with-candidate-card.js` only when narrower checks are insufficient.
- Repair the card itself, not unrelated board infrastructure.

## How to Interpret Failures

- `preflight-validate-candidate-card-definition.js` failures usually mean schema issues, invalid JSONata, invalid namespaces, or unsupported source fields.
- `preflight-probe-single-source-in-candidate-card.js` failures usually mean readiness, connectivity, or configuration issues in the lightweight probe path.
- `preflight-run-single-source-in-candidate-card.js` failures usually mean the actual fetch path failed because of projection shape problems, missing required source fields, or runtime connectivity/config issues.
- `preflight-materialize-candidate-card.js` failures usually mean broken compute expressions, wrong mock input shape, or card `provides[].ref` / `view` bindings that do not line up with the runtime namespaces produced by the card.
- `preflight-run-one-cycle-with-candidate-card.js` failures usually mean multiple layers are inconsistent; use its validation, source, compute, and materialized output sections to route the repair back to validation, source defs, compute, `provides[]`, or `view`.

Common repair routing:

- If a `provides[].ref` path is invalid, fix the namespace or the upstream field it targets.
- If a compute expression reads the wrong namespace, repair the expression before changing mocks.
- If a source probe fails because projections are wrong, repair the `projections` expressions or the source-specific fields that consume them.
- If validation fails on duplicate `bindTo` or `outputFile`, fix the card contract first; probing and compute checks come later.

## Command Rules

- Use the payload-driven commands in this skill for authoring-time correctness checks.
- Prefer minimal mock payloads. Only include the fields needed to exercise the touched source or compute path.
- If you edit only layout/view and validation passes, you usually do not need source probing.
- If you edit `source_defs[]`, do not stop at validation; always probe the touched sources.
- If you edit `compute[]`, do not stop at validation; run `preflight-materialize-candidate-card.js` with representative mocks.

## Payload Construction Rules

- If only validation is needed, use `{ "candidate_card_content": <card> }`.
- If probing a source, use `{ "candidate_card_content": <card>, "mock_projections": { ... } }`.
- If evaluating compute or validating `provides[]` / `view`, use `{ "candidate_card_content": <card>, "mock_fetched_sources": { ... }, "mock_requires": { ... } }` with `preflight-materialize-candidate-card.js`.
- If simulating a full cycle, use `{ "candidate_card_content": <card>, "mock_requires": { ... } }` and run it through `preflight-run-one-cycle-with-candidate-card.js --base-ref <board-ref>`.
- Required top-level fields must be present even when their values are empty objects.
- Use realistic field names and shapes, but keep the payload as small as possible.
- Preserve the actual `id`, `bindTo`, `outputFile`, and compute expressions from the card under repair.

## Example Payloads

### Source probe payload

```json
{
  "candidate_card_content": {
    "id": "card-example",
    "card_data": {},
    "source_defs": [
      {
        "bindTo": "quotes",
        "outputFile": "quotes.json"
      }
    ]
  },
  "mock_projections": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 }
    ]
  }
}
```

### Compute evaluation payload

```json
{
  "candidate_card_content": {
    "id": "card-example",
    "card_data": {},
    "compute": [
      {
        "bindTo": "holdingCount",
        "expr": "$count(requires.holdings)"
      },
      {
        "bindTo": "quoteCount",
        "expr": "$count(fetched_sources.quotes.rows)"
      }
    ]
  },
  "mock_requires": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 },
      { "ticker": "MSFT", "quantity": 2 }
    ]
  },
  "mock_fetched_sources": {
    "quotes": {
      "rows": [
        { "ticker": "AAPL", "price": 189.5 },
        { "ticker": "MSFT", "price": 421.2 }
      ]
    }
  }
}
```

### Simulate card cycle payload

```json
{
  "candidate_card_content": {
    "id": "card-example",
    "card_data": {
      "title": "Example card"
    },
    "source_defs": [
      {
        "bindTo": "quotes",
        "outputFile": "quotes.json",
        "projections": {
          "holdings": "requires.holdings"
        }
      }
    ],
    "compute": [
      {
        "bindTo": "rowCount",
        "expr": "$count(fetched_sources.quotes.rows)"
      }
    ]
  },
  "mock_requires": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 }
    ]
  }
}
```

This form is the default simulation payload: validation runs, projections are resolved from `mock_requires`, and source preflight runs against the card's `source_defs[]`.


 