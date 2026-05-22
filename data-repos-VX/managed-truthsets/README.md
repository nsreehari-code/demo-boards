# Finbook Managed Truthsets

This directory is the transitional split view for authoritative Finbook state concerns.

It is intended to own:
- schema and shared domain libraries
- MCP contract and validation logic
- managed truth storage such as sample DB shape, plus the live DB and journal at runtime
- export and report logic

`managed-truthsets/lib/` is the canonical home for the shared Finbook domain
libraries. Generated MCP-facing files such as `mcp-manifest.json`,
`mcp-executable-manifest.json`, `capabilities.json`, `computed-views.json`, and
`schema.json` should be refreshed from that library code via
`scripts/generate-mcp-manifests.cjs` rather than hand-maintained in
multiple locations.

`managed-truthsets/package.json` is the local package boundary for this tree. It
marks both `lib/` and `scripts/` as CommonJS and owns the primary build/test
entrypoints for this subtree.

The top-level generated manifest files remain checked in because runtime
discovery reads them directly. In particular, `mcp-server/registry.json` points
at `managed-truthsets/mcp-executable-manifest.json`, so these generated files
must exist in the repo unless every consumer is changed to build them first.

`DB/finbook.json` and `DB/finbook.journal.jsonl` are live runtime state and are
gitignored. Keep checked-in sample data in `DB/finbook.sample.json` for schema,
tooling, and validation examples.

Recommended commands:

- `npm --prefix data-repos-VX/managed-truthsets run build` — regenerate `mcp-manifest.json`, `mcp-executable-manifest.json`, `capabilities.json`, `computed-views.json`, and `schema.json`
- `npm --prefix data-repos-VX/managed-truthsets run check` — regenerate manifests, run Finbook smoke tests, and validate the checked-in sample DB
- `npm run finbook:build` / `npm run finbook:check` at the workspace root — convenience wrappers around the managed-truthsets package scripts

During the current compatibility phase, generated repos still keep the active runtime paths at the repository root. The setup hook mirrors those root truth-management files into `managed-truthsets/` so the storage split can be completed incrementally.