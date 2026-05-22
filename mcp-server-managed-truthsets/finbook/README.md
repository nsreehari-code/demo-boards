# Finbook Package

This directory is the authoritative Finbook package under `mcp-server-managed-truthsets/finbook`.

It is intended to own:
- schema and shared domain libraries
- MCP contract and validation logic
- truth-managed storage such as sample DB shape, plus the live DB and journal at runtime
- export and report logic

`lib/` is the canonical home for the shared Finbook domain
libraries. Generated MCP-facing files such as `mcp-manifest.json`,
`mcp-executable-manifest.json`, `capabilities.json`, `computed-views.json`, and
`schema.json` should be refreshed from that library code via
`scripts/generate-mcp-manifests.cjs` rather than hand-maintained in
multiple locations.

`package.json` is the local package boundary for this tree. It
marks both `lib/` and `scripts/` as CommonJS and owns the primary build/test
entrypoints for this subtree.

The top-level generated manifest files remain checked in because runtime
discovery reads them directly. In particular, `mcp-server/registry.json` points
at `mcp-server-managed-truthsets/finbook/mcp-executable-manifest.json`, so these generated files
must exist in the repo unless every consumer is changed to build them first.

`DB/finbook.json` and `DB/finbook.journal.jsonl` are live runtime state and are
gitignored. Keep checked-in sample data in `DB/finbook.sample.json` and
`DB/finbook.sample.journal.jsonl` for schema, tooling, validation examples, and
first-run starter data.

At build/setup time, `scripts/generate-mcp-manifests.cjs` now performs a
one-time bootstrap of the live runtime files from those checked-in samples. It
copies `DB/finbook.sample.json` to `DB/finbook.json` and
`DB/finbook.sample.journal.jsonl` to `DB/finbook.journal.jsonl` only when the
live target file does not already exist. Existing live data is never replaced.

Recommended commands:

- `npm --prefix mcp-server-managed-truthsets/finbook run build` — regenerate `mcp-manifest.json`, `mcp-executable-manifest.json`, `capabilities.json`, `computed-views.json`, and `schema.json`
- `npm --prefix mcp-server-managed-truthsets/finbook run check` — regenerate manifests, run Finbook smoke tests, and validate the checked-in sample DB
- `npm run finbook:build` / `npm run finbook:check` at the workspace root — convenience wrappers around the Finbook package scripts