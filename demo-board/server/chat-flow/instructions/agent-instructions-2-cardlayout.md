# Card Design Principles & Layout Guide

---

## Card Design Principles

- **Cards are not pages** — think post-it notes, not dashboards. The primary content (table, editable data) should be immediately visible, not buried below stacked metrics. Use at most one hero `metric`; collapse secondary summary figures into a single `text` line rather than multiple `metric` blocks.
- **Single responsibility** — each card answers one question. If the title needs "and", split it.
- **No redundancy across cards** — each column on a board should appear on exactly one card. If a value is already visible elsewhere, omit it; the user's eye can join cards mentally.
- **Aggregations are distinct** — a metric that summarises data from another card (total, count, average) is not redundant — it is new information. Keep it.
- **Separate input from output** — cards with editable elements (`editable-table`, `form`, `searchbox`, `selection`) should stay lean; put heavy compute and display in a separate downstream card that `requires` the published token.
- **Propagate data, not display** — use `provides` to pass data between cards; never duplicate a `source_defs[]` fetch for data another card already provides.
- **KISS** — if you are unsure whether a field adds value, leave it out. A sparse card that is immediately readable is better than a dense card that requires study.

---

## Layout

```json
"meta": {
  "presentation": {
    "footprint": "wide"
  }
}
```

Every card you author lives on the Main Canvas. Author only how the card should
*feel* to the user; the frontend computes where it goes.

- `meta.presentation.prominence` — how much the user should care about this card: `glance`, `standard`, `feature`, or `spotlight`. Default: `standard`; omit it unless the card should feel clearly lower or higher priority. A one-line `metric` can still be `spotlight`; a big reference `table` can be `glance`.
- `meta.presentation.footprint` — how much room the card needs to render well, independent of attention: `compact`, `standard`, `wide`, or `large`. Default: `standard`; omit it unless the card needs a non-standard width.
- `meta.presentation.resizable` — whether the user may resize the card at runtime. Default: `true`; omit it unless the card must be fixed-size (`false`).
- Do not author content shape — it is inferred from `view.elements[].kind` (a `table` card reads as data, a `chart` as a chart, `narrative`/`markdown` as a write-up, `todo` as a checklist).
- Do not author columns, pixel widths, or any coordinates. Initial canvas placement is computed in the frontend from board layout config, the runtime dependency graph, and `meta.presentation.*`. Live drag / resize state is runtime-owned and persisted separately from the card.

---

## View Kinds — Required Data Shape

Every element in `view.elements[]` resolves its `data.bind` (or other source)
and feeds the result to the renderer for that `kind`. The shape the renderer
expects is summarised below. When authoring or repairing a card, make sure the
`compute[]` step produces exactly the shape the chosen kind needs.

| kind             | Expected `data` shape                                                                  | Key `data.*` options                                |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `metric`         | Number / string, OR `{ title?, value, detail? }`                                       | (label comes from `element.label`)                  |
| `text`           | String (or anything stringifiable); `format: "file-links"` expects an array of files   | `format`, `style`, `hideIfEmpty`                    |
| `badge`          | String / number (rendered as text inside a colored pill)                               | `colorMap: { "<value>": "green"\|"amber"\|… }`      |
| `alert`          | Number, OR `{ value: number }`                                                         | `thresholds: { green, amber }` (each like `"<10"`)  |
| `narrative`      | String, OR `{ text: string }`                                                          | —                                                   |
| `markdown`       | Markdown string, OR `{ text: string }`                                                 | —                                                   |
| `list`           | Array of primitives / objects, OR plain object (rendered as key/value `dl`)            | `maxRows`, `placeholder`                            |
| `table`          | Array of row objects: `[{ colA, colB, ... }, ...]`                                     | `columns`, `maxRows`, `sortable`, `placeholder`     |
| `editable-table` | Same as `table` (array of row objects)                                                 | `columns`, `schema.properties`, `addRow`, `deleteRow`, `writeTo` |
| `chart`          | Array of row objects, OR `{ labels: [...], datasets: [{ label, data: [...] }] }`       | `chartType`, `columns`, `series`, `stacked`, `legend`, `grid`, `height` (see Charts section) |
| `searchbox`      | Single text/number/date field value, usually persisted through `card_data`                | `fields.properties` (single field), `writeTo`, `actionLabel` |
| `selection`      | Single selected value, with options from enum or bound row-source data                     | `fields.properties` (single field), `writeTo`      |
| `form`           | Object of current field values: `{ fieldA: ..., fieldB: ... }`                         | `fields` (JSON-schema-ish: `properties`, `required`), `writeTo` |
| `notes`          | String (the current notes content)                                                     | `writeTo`                                           |
| `todo`           | Array of items: `[{ text: string, done: boolean }, ...]`                               | `writeTo`                                           |
| `actions`        | (Optional) array of button defs; usually buttons come from `data.buttons`              | `buttons: [{ id, label, style?, size?, disabled? }]`|

Notes:

- Editable kinds (`editable-table`, `form`, `searchbox`, `selection`, `notes`, `todo`) must set
  `data.writeTo` to the data-object path their saves should publish to. Without
  `writeTo`, edits are dropped silently.
- `actions` buttons emit save events keyed by `button.id`; the card's action
  handler is expected to know what each id means.

---

## Charts (`kind: "chart"`)

The `chart` view kind renders real charts via recharts. It is declarative — you
choose `chartType` and which fields supply labels and values; the renderer takes
care of axes, legend, tooltip and colors.

### Supported `chartType` values

| chartType   | Use for                                                | Data shape                                |
| ----------- | ------------------------------------------------------ | ----------------------------------------- |
| `pie`       | Part-of-whole distribution (few categories)            | rows with one label + one value column    |
| `doughnut`  | Same as pie, with a centered hole                      | same as pie                               |
| `bar`       | Comparing categorical values (default for tabular)     | rows with one label + one or more values  |
| `line`      | Trends over an ordered/x axis                          | rows with one x + one or more y series    |
| `area`      | Trends with magnitude emphasis (often stacked)         | same as line                              |
| `scatter`   | Relationship between two numeric fields                | rows with one x (numeric) + one y         |

### Bind shapes

Two input shapes are accepted on `data.bind`:

1. **Row array** (preferred) — `[{ ticker: "AAPL", value: 1200 }, ...]`. Pick
   which columns drive the chart via `columns: [labelKey, valueKey, ...]`. For
   multi-series charts, list extra value columns or use `series: [...]`.
2. **Pre-shaped Chart.js-style object** —
   `{ labels: ["AAPL", ...], datasets: [{ label: "Value", data: [1200, ...] }] }`.
   The renderer flattens this automatically; `columns`/`series` are not needed.

### Declarative options on `data`

```json
{
  "kind": "chart",
  "label": "Portfolio Distribution",
  "data": {
    "bind": "computed_values.positions",
    "chartType": "pie",
    "columns": ["ticker", "value"],
    "height": 220,
    "legend": true,
    "grid": true,
    "stacked": false
  }
}
```

- `columns` — `[labelKey, ...valueKeys]`. For pie/doughnut, only the first value
  column is used. For bar/line/area, every value column becomes a series.
- `series` — explicit list of value keys (overrides `columns[1..]`).
- `chartType` — one of the table above. If omitted, the renderer guesses from
  the data shape.
- `stacked` — for bar/area, stack multi-series instead of grouping.
- `legend`, `grid` — toggle legend / grid lines (defaults: on when useful).
- `height` — pixel height of the chart area (default 220). Make sure the card's
  rendered shell leaves room for the chart plus header.

### Authoring tips

- Prefer computing a clean row array in `compute[]` (e.g. `positions` with
  `{ticker, value}`) and binding `kind: chart` to it. This keeps the same data
  reusable by `table` views and downstream cards.
- For pie/doughnut, keep categories under ~8; otherwise the legend dominates.
- For line/area trends, ensure the label column is already sorted by the
  compute step — the renderer does not reorder.

---

## Dynamic `ref` Rendering

When layout depends on a dynamic `ref` view, keep only the presentation goal in
mind here.

Use:

- `manage-cards-on-live-board` for `_view` authoring heuristics and `ref`-driven card patterns
