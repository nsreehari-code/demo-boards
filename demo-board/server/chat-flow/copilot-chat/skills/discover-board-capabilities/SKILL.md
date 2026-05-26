---
name: discover-board-capabilities
description: >
  Discover what a live board can do before authoring or repairing cards:
  supported source kinds and their authored field schemas.
---

# Discover Board Capabilities

## When To Use

Use this skill before authoring or editing `source_defs[]`, or any time the
task asks "what can this board fetch / which source kinds are available /
what fields does this source kind accept".

Use it to answer:

1. Which source kinds does this board's board worker / task executor support?
2. Which authored fields are valid on the chosen kind?
3. What capability metadata does the executor report for the chosen kind?

Use the executor capability report as the source of truth for source kinds,
source-specific fields, and `supports` metadata.

## Command Surface

Run these commands from the Copilot workspace root using the staged CLI in
`.github/scripts`.

### Discover supported source kinds and fields

```bash
node ./.github/scripts/discover-source-kinds.js
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

## Authoring Rules

- Treat `commonSourceDefFields` plus the chosen kind's `inputSchema` as the
  source of truth for authored `source_defs[]` fields.
- Keep `supports` in the discovery layer; it is capability metadata rather than
  a card-authored field.
- Validate each kind against its own schema instead of carrying fields across
  kinds.
- If a kind is missing from the discovery output, the executor must be extended
  before any card relying on it will work.

## Workflow

1. Run `discover-source-kinds` for the target board.
2. Pick the source kind directly from the returned `sourceKinds` map.
3. Author only the fields allowed by `commonSourceDefFields` and that kind's
  `inputSchema`.
4. Stay with the discovery output until you have identified the supported kind,
   its schema, and any relevant capability metadata.

The executor output is the contract for available source kinds and fields.

If the task shifts from capability discovery to validating whether an authored
card or source actually runs correctly, switch to `preflight-card-changes`
for execution checks.

## Related Skills

- `manage-cards-on-live-board` — when the discovery feeds into authoring or
  editing the card that uses the chosen source kind.
- `preflight-card-changes` — when the source is authored and you want a real
  end-to-end source run, compute, materialized `provides[]` / `view`, or
  full-cycle simulation.
