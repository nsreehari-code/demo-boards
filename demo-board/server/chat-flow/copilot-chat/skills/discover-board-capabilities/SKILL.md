---
name: discover-board-capabilities
description: >
  Discover what a live board can do before authoring or repairing cards:
  supported source kinds, their authored field schemas, and lightweight
  source-readiness probes.
---

# Discover Board Capabilities

## When To Use

Use this skill before authoring or editing `source_defs[]`, or any time the
task asks "what can this board fetch / which source kinds are available /
what fields does this source kind accept".

It answers three concrete questions:

1. Which source kinds does this board's board worker / task executor support?
2. Which authored fields are valid on the chosen kind?
3. Is one specific authored source reachable and well-configured before we
   commit to running it for real?

Do not guess source kinds, source-specific fields, or `supports` metadata from
nearby cards or prose. Query the executor.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in
`.github/scripts`.

### Discover supported source kinds and fields

```bash
node ./.github/scripts/discover-source-kinds.js --base-ref <board-ref>
```

Prints the source-authoring slice of the executor capability report:

```jsonc
{
  "version": "1.0",
  "commonSourceDefFields": { /* shared authored fields valid for every source_def */ },
  "sourceKinds": {
    "<kindName>": {
      "description": "What this kind does",
      "supports": { /* capability metadata, NOT a card field */ },
      "inputSchema": { /* allowed authored fields for this kind */ },
      "outputShape": "What the source returns",
      "note": "Constraints or usage notes"
    }
  }
}
```

### Lightweight source readiness probe

```bash
cat payload.json | node ./.github/scripts/preflight-probe-single-source-in-candidate-card.js --source-idx 0
```

Use this for a fast configuration / reachability check on one authored source.
For real end-to-end fetch validation, use `preflight-card-changes` instead.

Payload:

```json
{
  "candidate_card_content": { "id": "...", "source_defs": [ /* ... */ ] },
  "mock_projections": { /* may be empty */ }
}
```

Returned fields: `bindTo`, `reachable`, `latencyMs`, `note`.

## Authoring Rules

- Treat `commonSourceDefFields` plus the chosen kind's `inputSchema` as the
  source of truth for authored `source_defs[]` fields.
- Do not author `supports` on a card; it is discovery metadata only.
- Do not assume fields from one kind are valid on another.
- If a kind is missing from the discovery output, the executor must be extended
  before any card relying on it will work.

## Typical Source Kinds

Confirm against the executor for the current board, but typical kinds include:

- `mock` — fixture or canned values
- `urls` — HTTP fetches, with optional projections and fan-out
- `copilot` — Copilot-driven source generation (LLM source)
- `mcp` — calling an MCP tool through a configured server
- `foundry` — Azure AI Foundry agent or prompt execution
- `sqlite` — local SQLite queries

## Related Skills

These are not next steps in a pipeline — reach for them when the intent
shifts:

- `manage-cards-on-live-board` — when the discovery feeds into authoring or
  editing the card that uses the chosen source kind.
- `preflight-card-changes` — when the source is authored and you want a real
  end-to-end source run, compute, materialized `provides[]` / `view`, or
  full-cycle simulation.
