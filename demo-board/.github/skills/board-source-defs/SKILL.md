---
name: board-source-defs
description: >
  Discover which source-def kinds a board's task executor supports and
  what fields each kind requires. Use before authoring or modifying
  source_defs in card JSON.
---

# Board Source-Def Capabilities

## When to Use

Run `describe-task-executor-capabilities` **before** writing or changing
a `source_defs` entry in a card. It tells you exactly which source kinds
the executor supports and what fields each kind needs.

## CLI Command

```bash
npx board-live-cards-cli describe-task-executor-capabilities --rg <board-runtime-dir>
```

- `--rg` — path to the board runtime directory (must contain a
  `.task-executor` file pointing to the executor script)

The command prints a JSON object to stdout.

## Reading the Output

The output has this shape:

```jsonc
{
  "version": "1.0",
  "executor": "<executor-name>",
  "subcommands": ["run-source-fetch", "describe-capabilities", "validate-source-def"],
  "sourceKinds": {
    "<kindName>": {
      "description": "What this kind does",
      "inputSchema": { /* fields, types, required flags */ },
      "outputShape": "Description of what the executor returns",
      "note": "Optional usage notes"
    }
  },
  "extraSchema": { /* board topology context available to the executor */ }
}
```

### Key fields per source kind

| Field | Meaning |
|-------|---------|
| `description` | What the kind does |
| `inputSchema` | Required and optional fields for the source-def object |
| `outputShape` | What the fetched result looks like |
| `note` | Constraints, prerequisites, or gotchas |
| `example` | Sample input/output (when provided) |

## Common Source Kinds

These are the kinds typically available (run the command to confirm):

- **mock** — look up a key in a hardcoded dictionary
- **url** — single HTTP fetch with `{{key}}` interpolation
- **url-list** — fan-out over a pre-resolved URL list
- **copilot** — invoke GitHub Copilot CLI with a prompt template
- **workiq** — query Microsoft 365 Copilot
- **teams** — Microsoft Graph Teams API via Zoltbook

## Probe a Source (Live Test)

After writing a source-def, **probe it** to verify it actually fetches
data successfully — without running the full board.

### Probe a source by index (default: first source)

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> --rg <board-runtime-dir>
```

### Probe a specific source by bindTo name

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> --source-bind <bindTo-name> --rg <board-runtime-dir>
```

### Probe with mock projections

Most sources need `_projections` data that normally comes from upstream
`requires` cards. Supply mock values so the probe can run standalone:

```bash
npx board-live-cards-cli probe-source --card <path-to-card.json> \
  --mock-projections '{"holdings":[{"ticker":"AAPL","quantity":10}]}' \
  --rg <board-runtime-dir>
```

- `--mock-projections` — JSON string (or `@file.json`) providing the
  pre-resolved `_projections` the source needs. Craft the minimal
  payload that exercises the source. If omitted, `_projections` is `{}`.
- `--source-idx` — 0-based index into `source_defs[]` (default: 0).
- `--source-bind` — select source by its `bindTo` name instead of index.
- `--out <result.json>` — write the raw fetch result to a file for
  inspection.

### Reading probe output

The probe prints a structured report:

```
[probe-source] card:        my-card
[probe-source] source[0]:   bindTo="quotes" kind=url
[probe-source] _projections: {"holdings":[...]}
[probe-source] running fetch...
[probe-source] STATUS:      PROBE_PASS        ← or PROBE_FAIL
[probe-source] result size: 1234 bytes
[probe-source] sample:      {"quoteResponse":{"result":[...]}}...
```

The last line is machine-readable:
```
[probe-source:result] {"status":"PROBE_PASS","resultSize":1234,...}
```

- **Exit 0** — `PROBE_PASS` — source fetched successfully.
- **Exit 1** — `PROBE_FAIL` — error details printed.

## Typical Workflow

1. Run `describe-task-executor-capabilities` to see supported kinds.
2. Pick the appropriate kind for your data source.
3. Build the `source_defs` entry using the `inputSchema` fields.
4. Validate the card with the `board-validate-card` skill.
5. Probe the source with `probe-source` (and mock projections if needed)
   to confirm it fetches data correctly.
