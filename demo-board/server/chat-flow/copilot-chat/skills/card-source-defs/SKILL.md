---
name: card-source-defs
description: >
  Discover which source kinds and source_def fields a card can use.
  Use before authoring, repairing, or
  validating source_defs[] in card JSON.
---

# Card Source Defs

## When To Use

Use this skill before writing or changing `source_defs[]` in a card.

Use `card-authoring` for the full card workflow. Use this skill only for the
`source_defs[]` slice of that workflow.

It helps answer three concrete questions:

1. Which source kinds does this card support?
2. Which fields are valid for the chosen kind?
3. How do you preflight one source without running the full card workflow?

Do not guess source fields from examples or prose. Query the runtime
capabilities and use the declared schema they expose.

This skill uses the modern staged wrapper model:

- discovery uses `discover-source-kinds.js --base-ref <board-ref>`
- source preflight uses stdin payloads with `candidate_card_content`
- targeted source selection uses `--source-idx <n>`

Do not use the retired runtime-dir, card-file, or bind-name probing workflow in this skill.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in `.github/scripts`.

### Discover supported source kinds and fields

```bash
node ./.github/scripts/discover-source-kinds.js --base-ref <board-ref>
```

- `--base-ref` identifies the board whose configured task executor should be queried.

The command prints the source-authoring slice of the executor capability report
as JSON:

```jsonc
{
  "version": "1.0",
  "commonSourceDefFields": { /* shared authored fields valid for every source_def */ },
  "sourceKinds": {
    "<kindName>": {
      "description": "What this kind does",
      "supports": { /* capability metadata */ },
      "inputSchema": { /* allowed authored fields for this kind */ },
      "outputShape": "What the source returns",
      "note": "Constraints or usage notes"
    }
  }
}
```

### Lightweight source readiness preflight

```bash
cat payload.json | node ./.github/scripts/preflight-probe-single-source-in-candidate-card.js --source-idx 0
```

Use this when you want a lightweight configuration or reachability check for one source.

### Actual source run preflight

```bash
cat payload.json | node ./.github/scripts/preflight-run-single-source-in-candidate-card.js --source-idx 0
```

Use this as the authoritative preflight for a real authored source. It exercises the source's actual fetch path.

## How To Read The Output

The important parts of the response are:

### Meaning Of Each Field

| Field | Meaning |
|-------|---------|
| `commonSourceDefFields` | Shared authored fields allowed on every `source_def` |
| `sourceKinds.<kind>.inputSchema` | The exact kind-specific authored fields the runtime accepts |
| `sourceKinds.<kind>.supports` | Capability metadata for tooling and docs, not a field cards should author |

## Authoring Rules

- Treat `commonSourceDefFields` and `inputSchema` as the source of truth.
- Author the concrete source fields the chosen kind accepts.
- Do not add `supports` to card `source_defs[]`; it is discovery metadata only.
- Do not assume fields from another kind also work here.
- If validation rejects a field, remove or rename it instead of trying to force it through.
- Use `discover-source-kinds.js` before guessing source kinds or source-specific fields.

## Common Source Kinds

These are typical kinds, but always confirm by querying the executor for
the current board/runtime:

- `mock` for fixture or canned values.
- `urls` for HTTP fetches, optionally with projections and fan-out.
- `copilot` for Copilot-driven source generation.
- `mcp` for calling an MCP tool through a configured server.
- `foundry` for Azure AI Foundry agent or prompt execution.
- `sqlite` for local SQLite queries.

## Source Preflight Payload

Source preflight commands in this skill are stdin-driven. Supply a payload with the candidate card and the smallest projections needed to exercise the target source.

```json
{
  "candidate_card_content": {
    "id": "card-example",
    "card_data": {},
    "source_defs": [
      {
        "bindTo": "quotes",
        "kind": "urls",
        "outputFile": "quotes.json",
        "projections": {
          "holdings": "requires.holdings"
        }
      }
    ]
  },
  "mock_projections": {
    "holdings": [
      { "ticker": "AAPL", "quantity": 10 }
    ]
  }
}
```

Payload rules:

- `candidate_card_content` must be a JSON object.
- `mock_projections` should be an object and may be empty.
- `--source-idx <n>` selects the zero-based source index from `source_defs[]`.
- If you know the source by `bindTo` name, inspect the card and resolve it to its zero-based index before running preflight.

## How To Preflight A Source

After authoring a `source_def`, preflight it directly before relying on it in the full card flow.

### Lightweight readiness check

```bash
cat payload.json | node ./.github/scripts/preflight-probe-single-source-in-candidate-card.js --source-idx 0
```

### Actual fetch-path check

```bash
cat payload.json | node ./.github/scripts/preflight-run-single-source-in-candidate-card.js --source-idx 0
```

Use `preflight-run-single-source-in-candidate-card.js` as the default when deciding whether the authored source is actually correct.

## Typical Workflow

1. Run `discover-source-kinds.js --base-ref <board-ref>`.
2. Choose the source kind that matches the data you need.
3. Build the `source_def` using `commonSourceDefFields` plus that kind's `inputSchema`.
4. Validate the card and fix unsupported fields.
5. Build the smallest stdin payload with `candidate_card_content` and `mock_projections` for the touched source.
6. Run `preflight-run-single-source-in-candidate-card.js --source-idx <n>` for the target source.
7. Use `preflight-probe-single-source-in-candidate-card.js --source-idx <n>` only when a lighter readiness or configuration check is sufficient.
8. Only then wire downstream compute or view logic against the fetched result.

## Relationship To Other Skills

- Use `card-authoring` when creating the full card structure.
- Use `card-editing` when repairing or changing an existing card.
- Use `ensure-card-correctness` after authoring to validate and preflight the card.
- Use this skill when the question is specifically about supported source kinds, valid source fields, or source probing.