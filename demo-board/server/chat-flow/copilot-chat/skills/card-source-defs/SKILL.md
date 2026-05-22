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
3. How do you probe a source without running the full card workflow?

Do not guess source fields from examples or prose. Query the runtime
capabilities and use the declared schema they expose.

## Primary Command

```bash
npx board-live-cards-cli describe-task-executor-capabilities --rg <board-runtime-dir>
```

- `--rg` points at the board runtime directory.

The command prints the supported source kinds and field shapes
as JSON.

## How To Read The Output

The important parts of the response are:

```jsonc
{
  "version": "1.0",
  "subcommands": ["run-source-fetch", "describe-capabilities", "validate-source-def"],
  "commonSourceDefFields": { /* shared authored fields valid for every source_def */ },
  "sourceKinds": {
    "<kindName>": {
      "description": "What this kind does",
      "supports": { /* capability metadata */ },
      "inputSchema": { /* allowed authored fields for this kind */ },
      "outputShape": "What the source returns",
      "note": "Constraints or usage notes"
    }
  },
  "extraSchema": { /* runtime context passed separately via --extra */ }
}
```

### Meaning Of Each Field

| Field | Meaning |
|-------|---------|
| `commonSourceDefFields` | Shared authored fields allowed on every `source_def` |
| `sourceKinds.<kind>.inputSchema` | The exact kind-specific authored fields the runtime accepts |
| `sourceKinds.<kind>.supports` | Capability metadata for tooling and docs, not a field cards should author |
| `extraSchema` | Runtime context supplied by the system, not part of authored card JSON |

## Authoring Rules

- Treat `commonSourceDefFields` and `inputSchema` as the source of truth.
- Author the concrete source fields the chosen kind accepts.
- Do not add `supports` to card `source_defs[]`; it is discovery metadata only.
- Do not assume fields from another kind also work here.
- If validation rejects a field, remove or rename it instead of trying to force it through.

## Common Source Kinds

These are typical kinds, but always confirm by querying the executor for
the current board/runtime:

- `mock` for fixture or canned values.
- `urls` for HTTP fetches, optionally with projections and fan-out.
- `copilot` for Copilot-driven source generation.
- `mcp` for calling an MCP tool through a configured server.
- `foundry` for Azure AI Foundry agent or prompt execution.
- `sqlite` for local SQLite queries.

## Probe A Source

After authoring a `source_def`, probe it directly before relying on it in
the full card flow.

### Probe the first source on a card

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> --rg <board-runtime-dir>
```

### Probe a specific source by bind name

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> --source-bind <bindTo-name> --rg <board-runtime-dir>
```

### Probe with mock projections

If the source depends on upstream projections, supply a minimal mock
payload so the source can run in isolation:

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> \
  --mock-projections '{"holdings":[{"ticker":"AAPL","quantity":10}]}' \
  --rg <board-runtime-dir>
```

- `--mock-projections` supplies the `_projections` values the source would normally receive from upstream card data.
- `--source-idx` selects a source by zero-based index.
- `--source-bind` selects a source by `bindTo` name.
- `--out <result.json>` writes the raw fetch result for inspection.

## Typical Workflow

1. Run the capabilities command above.
2. Choose the source kind that matches the data you need.
3. Build the `source_def` using `commonSourceDefFields` plus that kind's `inputSchema`.
4. Validate the card and fix unsupported fields.
5. Probe the source with minimal projections.
6. Only then wire downstream compute or view logic against the fetched result.

## Relationship To Other Skills

- Use `card-authoring` when creating the full card structure.
- Use `card-editing` when repairing or changing an existing card.
- Use `ensure-card-correctness` after authoring to validate and preflight the card.
- Use this skill when the question is specifically about supported source kinds, valid source fields, or source probing.