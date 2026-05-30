---
name: discover-board-capabilities
description: >
  Discover a board's supported source kinds, authored fields, and capability
  metadata before authoring or repairing cards via MCP tool
  `liveboards.discover.source-kinds`.
---

# Discover Board Capabilities

## When To Use

Use before authoring or editing `source_defs[]`, or when the task requires knowing what source kinds the board supports, which fields they accept, or what capability metadata the executor reports. Treat the executor capability report as the source of truth.

## MCP Surface

Call `liveboards.discover.source-kinds` with

Arguments:

```json
{ "board_id": "<boardId>", "log_id": "<logId>" }
```

Pass the runtime `boardId` as `board_id` and the runtime `logId` as `log_id`
(opaque; forward unchanged).

Response Shape:

```jsonc
{
  "version": "1.0",
  "commonSourceFields": { /* shared authored fields valid for every source_def */ },
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

- Author only fields from `commonSourceFields` and the chosen kind's `inputSchema`. Do not carry fields across kinds.
- `supports` is capability metadata, not a card-authored field.
- A missing kind means the executor does not support it; do not author a card for it.

## Related Skills

- `manage-cards-on-live-board` — authoring or editing a card for the discovered source kind.
- `preflight-card-changes` — validating that an authored source actually runs end-to-end.