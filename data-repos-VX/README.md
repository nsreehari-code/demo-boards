# Data Repository

This repository is a git-backed data store managed by AI steward agents.

## Structure

- `managed-truthsets/` — Authoritative Finbook state, schema, validation, reports, generated MCP manifests, and shared truth-management logic
- `managed-truthsets/DB/finbook.json` — Financial database (accounts, income, stocks, taxes)
- `managed-truthsets/lib/` — Canonical Finbook domain libraries
- `managed-truthsets/scripts/` — Maintained validator, report, test, and manifest-generation scripts
- `case-workspace/` — Generated steward workspace artifacts, instructions, and domain-agent material

## How It Works

1. Agents operate on the Finbook MCP/tool surface backed by `managed-truthsets/`.
2. Transactional writes flow through journal-backed Finbook tools instead of direct JSON edits.
3. Validation, reporting, and manifest generation run from `managed-truthsets/scripts/`.
4. `case-workspace/` holds generated working copies and steward-facing workflow material rather than the canonical truthsets.

## Evidence-Based Principle

All data extraction is evidence-based. If information is not explicitly stated in a source document, it is not entered. The system never infers, assumes, or fills from past data.

## Finbook Domain

This is a **Finbook** data repository — Indian personal tax tracking.

### Additional Structure
- `managed-truthsets/scripts/validate-finbook.js` — Deterministic validator
- `managed-truthsets/scripts/finbook-report.js` — Computed report tool
- `managed-truthsets/lib/finbook-core.js` — Shared schema/computation library
- `case-workspace/` — Generated steward instructions, domain agents, and case-workspace artifacts

### Domain Agents
- `@record-extractor` — Extracts financial records from tax documents
- `@claim-recorder` — Records cross-verification claims from summary documents
- `@claim-verifier` — Verifies claims against DB records

### Preferred Agent Tool Order
- Use semantic write tools first: `record_*` for transactional records and `append_*` for append-only account profile / repo config data.
- Use generic row tools second: `upsert_row` and `delete_row` only when no semantic tool applies.
- Use targeted reads first: accounts, account profile, repo config, table rows, and reports.
- Use full-state reads last: committed or working state snapshots are fallback tools for broad reasoning, not the default query path.

### MCP Discovery Hints
- `finbook.describe_semantic_structure` explains the meaning of the top-level model, tables, computed views, and preferred mutation patterns.
- `finbook.validate_working_state` validates the current working state without requiring direct file access.
- Agents should use the Finbook MCP/tool surface instead of editing `managed-truthsets/DB/finbook.json` directly.
