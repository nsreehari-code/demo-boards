---
name: ensure-card-correctness
description: >
  Validate and repair a board card end to end using the current yaml-flow
  preflight CLI. Use after creating or editing card JSON, especially when the
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

This skill is the operational runbook for the current yaml-flow CLI surface.
Use the commands in this file as the authoritative workflow.

If a validation or repair task depends on decisions captured in another card's discussion, use `chat-store-commands` to read that chat history before making further changes.

Use the returned card JSON as the basis for validation, source probe payloads,
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
- If a source repair changes projections, build the smallest `mock-projections` payload that exercises that same source.
- Treat source-specific fields beyond `bindTo` and `outputFile` as executor-defined; repair them by following known working patterns rather than guessing broad new shapes.

## Command Surface

Run these commands from the repo root, using the current JS CLI entrypoint:

```bash
node ./.github/scripts/board-live-cards-cli.js validate-card-preflight
```

The commands below are payload-driven and read JSON from stdin.

For a cross-platform file-to-stdin pattern, use:

```bash
node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" <payload.json> | node ./.github/scripts/board-live-cards-cli.js <subcommand>
```

Replace `<payload.json>` and `<subcommand>` as needed.

### 1. Validate card structure and semantics

```bash
node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" <card.json> | node ./.github/scripts/board-live-cards-cli.js validate-card-preflight
```

Accepted stdin shapes:

- raw card JSON
- `{ "card-content": <card-json> }`

Actual payload contract:

- stdin must be a JSON object
- the command validates `body["card-content"] ?? body`
- no top-level mock fields are used by this command

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

### 2. Probe one source preflight

```bash
node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" <payload.json> | node ./.github/scripts/board-live-cards-cli.js probe-source-preflight --source-idx 0
```

`payload.json` should contain either the raw card object or:

```json
{
  "card-content": { "id": "...", "source_defs": [] },
  "mock-projections": {}
}
```

Actual payload contract:

- stdin must be a JSON object
- the command reads `body["card-content"] ?? body`
- the command reads `body["mock-projections"] ?? {}`
- the command requires `--source-idx <n>`
- the command does not read `mock-requires` or `mock-fetched-sources`

Required argument:

- `--source-idx <n>`: zero-based source index in `source_defs[]`

Optional:

- `--out-ref <ref>` if a downstream workflow explicitly needs the result stored

Expected result includes fields like:

- `bindTo`
- `reachable`
- `latencyMs`
- `note`

### 3. Evaluate compute without running a full board

```bash
node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" <payload.json> | node ./.github/scripts/board-live-cards-cli.js eval-card-compute
```

Optional payload fields:

- `mock-fetched-sources`
- `mock-requires`

Actual payload contract:

- stdin must be a JSON object
- the command reads `body["card-content"] ?? body`
- the command reads `body["mock-fetched-sources"] ?? {}`
- the command reads `body["mock-requires"] ?? {}`
- no `mock-projections` field is used by this command

Expected result includes:

- `ok`
- `computed_values`
- `errors`

### 4. Simulate the full card cycle

```bash
node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" <payload.json> | node ./.github/scripts/board-live-cards-cli.js simulate-card-cycle
```

Use this when the card couples validation, projections, sources, and compute and
you want a combined result in one pass.

Expected result includes:

- `validation`
- `source_probes`
- `projection_errors`
- `computed_values`
- `compute_errors`
- top-level `ok`

Actual payload contract:

- stdin must be a JSON object
- the command reads `body["card-content"] ?? body`
- the command reads `body["mock-fetched-sources"] ?? {}`
- the command reads `body["mock-requires"] ?? {}`
- the command optionally reads `body["task-executor-ref"]`
- no `mock-projections` field is used directly by this command
- source preflight still runs against the card's `source_defs[]`
- `mock-fetched-sources` is optional; if omitted, the compute phase runs with an empty `fetched_sources` object

## Repair Workflow

Follow this exact order.

1. Run `validate-card-preflight` first.
2. If it reports issues, repair the card JSON first. Do not move to probing or compute until validation is clean.
3. If the changed card has `source_defs[]`, build the smallest payload that exercises only the touched source and run `probe-source-preflight` for each changed source index.
4. If the changed card has `compute[]`, build the smallest representative mocks and run `eval-card-compute`.
5. If targeted checks are individually clean but the card is still suspicious, run `simulate-card-cycle` to surface cross-layer inconsistencies.
6. Repeat until validation is clean and every touched source or compute path has a passing result.

## Preferred Scope Discipline

- Start with the one card you changed.
- Never change the `id` of a card.
- Start with the one source index or compute path you changed.
- Use minimal mocks, not full board snapshots.
- Escalate to `simulate-card-cycle` only when narrower checks are insufficient.
- Repair the card itself, not unrelated board infrastructure.

## How to Interpret Failures

- `validate-card-preflight` failures usually mean schema issues, invalid JSONata, invalid namespaces, or unsupported source fields.
- `probe-source-preflight` failures usually mean projection shape problems, missing required source fields, or executor-specific connectivity/config issues.
- `eval-card-compute` failures usually mean broken compute expressions or wrong mock input shape.
- `simulate-card-cycle` failures usually mean multiple layers are inconsistent; use its sections to route the repair back to validation, source defs, or compute.

Common repair routing:

- If a `provides[].ref` path is invalid, fix the namespace or the upstream field it targets.
- If a compute expression reads the wrong namespace, repair the expression before changing mocks.
- If a source probe fails because projections are wrong, repair the `projections` expressions or the source-specific fields that consume them.
- If validation fails on duplicate `bindTo` or `outputFile`, fix the card contract first; probing and compute checks come later.

## Operational Rules

- Use the payload-driven commands in this skill for authoring-time correctness checks.
- Prefer minimal mock payloads. Only include the fields needed to exercise the touched source or compute path.
- If you edit only layout/view and validation passes, you usually do not need source probing.
- If you edit `source_defs[]`, do not stop at validation; always probe the touched sources.
- If you edit `compute[]`, do not stop at validation; run compute evaluation with representative mocks.

## Payload Construction Rules

- If only validation is needed, stdin can be the raw card JSON.
- If probing a source, prefer `{ "card-content": <card>, "mock-projections": { ... } }`.
- If evaluating compute, prefer `{ "card-content": <card>, "mock-fetched-sources": { ... }, "mock-requires": { ... } }`.
- If simulating a full cycle, prefer `{ "card-content": <card>, "mock-requires": { ... } }`.
- Add `mock-fetched-sources` only when you intentionally want to supply compute inputs instead of leaving `fetched_sources` empty for the compute phase.
- Add `task-executor-ref` only when you need to override the board's configured executor.
- Use realistic field names and shapes, but keep the payload as small as possible.
- Preserve the actual `id`, `bindTo`, `outputFile`, and compute expressions from the card under repair.

## Example Payloads

### Source probe payload

```json
{
  "card-content": {
    "id": "card-example",
    "card_data": {},
    "source_defs": [
      {
        "bindTo": "quotes",
        "outputFile": "quotes.json"
      }
    ]
  },
  "mock-projections": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 }
    ]
  }
}
```

### Compute evaluation payload

```json
{
  "card-content": {
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
  "mock-requires": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 },
      { "ticker": "MSFT", "quantity": 2 }
    ]
  },
  "mock-fetched-sources": {
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
  "card-content": {
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
  "mock-requires": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 1 }
    ]
  }
}
```

This form is the default simulation payload: validation runs, projections are resolved from `mock-requires`, and source preflight runs against the card's `source_defs[]`.


 