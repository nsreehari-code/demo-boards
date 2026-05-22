---
name: card-editing
description: >
  Edit an existing board card safely and minimally. Use when a task requires
  changing one card's layout, sources, compute, requires, provides, or view
  without rewriting unrelated parts of the card.
---

# Card Editing

## When to Use

Use this skill when the task is to modify an existing card rather than create a
 new one.

`card-store-commands` is a prerequisite skill for this workflow because cards
always originate from the board card store.

Use it especially when the request says things like:

- update this card
- fix this card
- change the layout
- adjust compute
- add or repair a source
- edit `requires`, `provides`, or `view`

## Editing Discipline

- Use `card-store-commands` to read and persist the card.
- Read the full existing card before changing it.
- Keep the edit as narrow as possible.
- Preserve the card's dataflow unless the task is explicitly fixing that dataflow.
- Never change the `id` of an existing card.
- Do not edit `card_data` except for narrow syntax, formatting, or structural repair cases; it contains user-edited information, uploaded files, and other user-managed content.
- If the requested edit depends on context from another card's discussion, use `chat-store-commands` to read that card's chat history before changing this card.
- Preserve fields and behavior outside the requested change.
- Preserve existing naming unless the task explicitly requires a rename.
- Preserve existing `bindTo`, `outputFile`, `requires`, and `provides` entries unless they are part of the requested repair.
- Prefer editing one logical slice at a time: layout, one source, one compute path, or one data section.

## Dataflow Constraints

- Keep the execution order coherent: `source_defs[]` -> `fetched_sources.*` -> `compute[]` -> `computed_values.*` -> `view` and `provides[]`.
- `source_defs` is configuration, not a runtime namespace. If an edit touches data bindings, read fetched data from `fetched_sources.*`.
- If the card's existing dataflow is wrong, repair it directly rather than working around it somewhere else in the card.

## Contract Repairs

- `requires[]` and `provides[]` are editable when the task is fixing a broken token contract.
- When repairing expressions that read required tokens, use `requires.<key>` for normal token names and JSONata `$lookup(requires, 'my-key')` for hyphenated ones.
- If the task changes `source_defs[]` shape or source field names, use `card-source-defs` to confirm which source kinds and fields are valid before editing.
- If the task touches a source's `projections`, keep them limited to `card_data` and `requires`.
- Do not introduce `fetched_sources`, `computed_values`, or `source_defs` into `projections` while repairing a source.
- If the task introduces or repairs LLM behavior, keep it inside `source_defs[]`; do not invent a separate non-source mechanism.

## Recommended Workflow

1. Use `card-store-commands` to load the current card with the provided `store-ref` and `cardId`.
2. Identify the smallest card slice that actually needs to change.
3. Keep the existing structure and style unless the current shape is itself the problem.
4. If the edit touches `source_defs[]`, use `card-source-defs` when you need to verify valid source kinds, source fields, or source probing steps.
5. Apply the smallest edit that satisfies the request, then persist it through `card-store-commands`.
6. If the change touches `source_defs[]`, `compute[]`, `requires[]`, `provides[]`, or `view`, immediately hand off to `ensure-card-correctness`.
7. Stop after the requested card is correct. Do not expand into unrelated card cleanup.

## How to Edit Safely

- For layout-only requests, prefer changing `view` or presentation fields without disturbing source and compute logic.
- For source changes, preserve unaffected source entries and probe only the touched source indices during correctness checks.
- For source repairs, it is acceptable to change `bindTo`, `outputFile`, source-specific fields, or projections when those are the broken part of the card.
- For compute changes, preserve unaffected compute entries and test only the touched compute paths during correctness checks.
- For `requires` or `provides` changes, update only the fields needed for the requested contract change or repair.
- Treat `card_data` as protected user content, not as an authoring surface for routine card edits. Only touch it to repair syntax, formatting, or broken structure without changing the user-managed content itself.
- If the task involves uploaded or attached files, read the card first, take the relevant artifact key from `card_data.files`, and use `artifacts-store-commands` to inspect the file.
- If the card already contains a working pattern for the same kind of field, follow that pattern instead of inventing a new shape.

## What Not to Do

- Do not rewrite the whole card when one field or section is enough.
- Do not rename the card `id`.
- Do not modify `card_data` content during routine editing. Only make narrow syntax, formatting, or structural fixes when there is no safer path.
- Do not remove fields just because they look unused unless the task explicitly requires removal.
- Do not change neighboring cards as part of this skill.
- Do not treat formatting churn as useful progress.

## Handoff

After editing, use `ensure-card-correctness` as the required follow-up skill.

If the uncertainty is specifically about supported source kinds, valid source
fields, or source probing, use `card-source-defs` before or during that
correctness pass.

Use that skill to:

- validate the edited card
- run `run-source-preflight` for touched sources so the agent can verify the real source path still works
- evaluate touched compute paths
- run full simulation only if narrower checks are insufficient