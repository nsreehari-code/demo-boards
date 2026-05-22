import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ResponsiveContainer,
  PieChart, Pie, Cell,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

const CHART_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

export const CARD_CORE_VIEW_KINDS = {
  table: { Component: TableView, isEditable: false },
  searchbox: { Component: QueryView, isEditable: true },
  selection: { Component: SelectionView, isEditable: true },
  metric: { Component: MetricView, isEditable: false },
  list: { Component: ListView, isEditable: false },
  chart: { Component: ChartView, isEditable: false },
  form: { Component: FormView, isEditable: true },
  notes: { Component: NotesView, isEditable: true },
  'editable-table': { Component: EditableTableView, isEditable: true },
  todo: { Component: TodoView, isEditable: true },
  alert: { Component: AlertView, isEditable: false },
  narrative: { Component: NarrativeView, isEditable: false },
  badge: { Component: BadgeView, isEditable: false },
  text: { Component: TextView, isEditable: false },
  markdown: { Component: MarkdownView, isEditable: false },
  actions: { Component: ActionsView, isEditable: false },
};

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseThreshold(expr) {
  const match = String(expr ?? '').match(/^(<=?|>=?|===?)\s*(.+)$/);
  if (!match) return null;
  return { op: match[1], value: Number.parseFloat(match[2]) };
}

function evalThreshold(value, expr) {
  const threshold = parseThreshold(expr);
  if (!threshold || Number.isNaN(threshold.value)) return false;
  switch (threshold.op) {
    case '<':
      return value < threshold.value;
    case '<=':
      return value <= threshold.value;
    case '>':
      return value > threshold.value;
    case '>=':
      return value >= threshold.value;
    case '=':
    case '==':
    case '===':
      return value === threshold.value;
    default:
      return false;
  }
}

function detectChartType(data) {
  if (!data.length) return 'bar';
  const sample = data[0];
  if (sample?.label !== undefined && sample?.value !== undefined && sample?.x === undefined && sample?.date === undefined) {
    return 'pie';
  }
  if (sample?.x !== undefined || sample?.date !== undefined) return 'line';
  return 'bar';
}
function getObjectColumns(rows, configuredColumns) {
  if (Array.isArray(configuredColumns) && configuredColumns.length) return configuredColumns;
  const keys = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      Object.keys(row).forEach((key) => keys.add(key));
    }
  }
  return [...keys];
}

function mergeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...(row ?? {}) }));
}

function getSingleFieldConfig(renderDef, data) {
  const viewData = renderDef?.data ?? {};
  const schema = viewData.fields ?? {};
  const props = schema.properties ?? {};
  const entries = Object.entries(props);
  if (entries.length !== 1) return null;

  const [fieldKey, prop] = entries[0];
  const resolvedWriteValue = renderDef?.resolvedWriteValue;
  const currentValue = viewData.writeTo === 'card_data'
    ? (resolvedWriteValue && typeof resolvedWriteValue === 'object' && !Array.isArray(resolvedWriteValue)
      ? resolvedWriteValue[fieldKey]
      : undefined)
    : resolvedWriteValue;

  let options = [];
  if (Array.isArray(prop?.enum)) {
    options = prop.enum;
  } else if (Array.isArray(data)) {
    options = data;
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(data[fieldKey])) {
      options = data[fieldKey];
    } else if (Array.isArray(data.options)) {
      options = data.options;
    }
  }

  return {
    viewData,
    schema,
    fieldKey,
    prop: prop ?? {},
    currentValue,
    options,
    isRequired: Array.isArray(schema.required) && schema.required.includes(fieldKey),
  };
}

function buildEditorSaveValue(writeTo, fieldKey, nextValue) {
  if (writeTo === 'card_data') {
    return { [fieldKey]: nextValue };
  }

  return nextValue;
}

function CardFrame({ label, kind, children }) {
  const showLabel = label && kind !== 'metric' && kind !== 'alert';
  return (
    <div className="w-100 d-flex flex-column">
      {showLabel ? <div className="board-card-frame__label mb-2">{label}</div> : null}
      <div>{children}</div>
    </div>
  );
}

function TableView({ data, renderDef }) {
  const viewData = renderDef?.data ?? {};

  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    setSortCol(null);
    setSortDir('asc');
  }, [data]);

  if (!Array.isArray(data) || !data.length) {
    return <p className="board-text-muted small mb-0">{viewData.placeholder ?? 'No data'}</p>;
  }

  const limit = Math.min(data.length, viewData.maxRows ?? 200);
  const columns = getObjectColumns(data.slice(0, limit), viewData.columns);
  const sortable = viewData.sortable !== false;

  let rows = data.slice(0, limit);
  if (sortable && sortCol !== null) {
    const sortKey = columns[sortCol];
    rows = rows.slice().sort((left, right) => {
      const leftValue = left?.[sortKey];
      const rightValue = right?.[sortKey];
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return sortDir === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      }
      const leftText = String(leftValue);
      const rightText = String(rightValue);
      return sortDir === 'asc' ? leftText.localeCompare(rightText) : rightText.localeCompare(leftText);
    });
  }

  return (
    <div className="d-flex flex-column">
      <div className="table-responsive">
        <table className="table table-sm table-striped table-hover board-data-table">
          <thead>
            <tr>
              {columns.map((column, index) => {
                const arrow = sortCol === index ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                return (
                  <th
                    key={column}
                    className="small text-nowrap"
                    role={sortable ? 'button' : undefined}
                    style={sortable ? { cursor: 'pointer' } : undefined}
                    onClick={sortable ? () => {
                      if (sortCol === index) {
                        setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
                      } else {
                        setSortCol(index);
                        setSortDir('asc');
                      }
                    } : undefined}
                  >
                    {column}{arrow}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={column} className="small">{row?.[column] != null ? String(row[column]) : ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > limit ? (
        <p className="board-text-muted small mt-2 mb-0">Showing {limit} of {data.length} rows</p>
      ) : null}
    </div>
  );
}

function FilterView({ data, renderDef, onSave }) {
  const singleField = getSingleFieldConfig(renderDef, data);
  if (singleField) {
    if (singleField.options.length || Array.isArray(singleField.prop.enum)) {
      return <SelectionView data={data} renderDef={renderDef} onSave={onSave} />;
    }

    if ((singleField.prop.type ?? 'string') === 'string') {
      return <QueryView data={data} renderDef={renderDef} onSave={onSave} />;
    }
  }

  return <FormView data={data} renderDef={renderDef} onSave={onSave} />;
}

function normalizeLegacyKind(kind, renderDef, data) {
  if (kind === 'query') return 'searchbox';
  if (kind !== 'filter') return kind;

  const singleField = getSingleFieldConfig(renderDef, data);
  if (!singleField) return 'form';

  if (singleField.options.length || Array.isArray(singleField.prop.enum)) {
    return 'selection';
  }

  if ((singleField.prop.type ?? 'string') === 'string') {
    return 'searchbox';
  }

  return 'form';
}

function SelectionView({ data, renderDef, onSave }) {
  const singleField = getSingleFieldConfig(renderDef, data);
  if (!singleField) {
    return <p className="board-text-muted small mb-0">No selection configured</p>;
  }

  const { fieldKey, prop, currentValue, options, isRequired, viewData } = singleField;
  const handleSubmit = useCallback((event) => {
    event.preventDefault();
    onSave?.(
      buildEditorSaveValue(viewData.writeTo, fieldKey, currentValue ?? ''),
      { kind: 'selection', renderDef, writeTo: viewData.writeTo },
    );
  }, [currentValue, fieldKey, onSave, renderDef, viewData.writeTo]);
  const handleChange = useCallback((event) => {
    const nextValue = event.target.value;
    onSave?.(
      buildEditorSaveValue(viewData.writeTo, fieldKey, nextValue),
      { kind: 'selection', renderDef, writeTo: viewData.writeTo },
    );
  }, [fieldKey, onSave, renderDef, viewData.writeTo]);

  return (
    <form className="input-group input-group-sm" onSubmit={handleSubmit}>
      <select
        className="form-select board-select"
        value={currentValue ?? ''}
        required={isRequired}
        aria-label={prop.title ?? fieldKey}
        onChange={handleChange}
      >
        {!isRequired ? <option value="">All</option> : null}
        {options.map((option) => {
          const optionValue = option != null && typeof option === 'object'
            ? String(option.value ?? option.id ?? option.label ?? '')
            : String(option ?? '');
          const optionLabel = option != null && typeof option === 'object'
            ? String(option.label ?? option.title ?? option.value ?? option.id ?? '')
            : String(option ?? '');
          return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
        })}
      </select>
    </form>
  );
}

function MetricView({ data, renderDef }) {
  let title = renderDef?.label ?? '';
  let value = '—';
  let detail = '';

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    title = data.title ?? data.label ?? data.metric ?? title;
    value = data.value != null ? String(data.value) : '—';
    detail = data.detail ?? '';
  } else if (data != null) {
    value = String(data);
  }

  return (
    <div className="board-metric">
      {title ? <div className="board-metric__label">{title}</div> : null}
      <div className="board-metric__value">{value}</div>
      {detail ? <div className="board-metric__detail">{detail}</div> : null}
    </div>
  );
}

function ListView({ data, renderDef }) {
  const viewData = renderDef?.data ?? {};

  if (data == null) return null;

  if (Array.isArray(data)) {
    if (!data.length) {
      return <p className="board-text-muted small mb-0">{viewData.placeholder ?? 'Empty'}</p>;
    }
    if (typeof data[0] === 'string' || typeof data[0] === 'number') {
      const max = viewData.maxRows ?? data.length;
      return (
        <ul className="list-unstyled mb-0">
          {data.slice(0, max).map((item, index) => (
            <li key={index} className="small mb-1">• {String(item)}</li>
          ))}
        </ul>
      );
    }
    return <TableView data={data} renderDef={renderDef} />;
  }

  if (typeof data === 'object') {
    return (
      <dl className="row mb-0">
        {Object.entries(data).map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="col-sm-5 small board-text-muted text-truncate">{key}</dt>
            <dd className="col-sm-7 small mb-1">{value != null ? String(value) : '—'}</dd>
          </React.Fragment>
        ))}
      </dl>
    );
  }

  return <div className="small">{String(data)}</div>;
}

function normalizeChartData({ data, viewData }) {
  // Chart.js-style pre-shaped input: { labels: [...], datasets: [{ label, data }, ...] }
  if (data && !Array.isArray(data) && typeof data === 'object'
      && Array.isArray(data.labels) && Array.isArray(data.datasets)) {
    const labels = data.labels;
    const datasets = data.datasets;
    const seriesNames = datasets.map((d, i) => d?.label ?? `series${i + 1}`);
    const rows = labels.map((label, i) => {
      const row = { __label: label };
      datasets.forEach((d, j) => {
        const val = Array.isArray(d?.data) ? d.data[i] : undefined;
        row[seriesNames[j]] = val;
      });
      return row;
    });
    return { rows, labelKey: '__label', seriesKeys: seriesNames };
  }

  if (!Array.isArray(data) || !data.length) return null;

  // Array of primitives → one series, index-based labels
  if (typeof data[0] !== 'object' || data[0] === null) {
    const rows = data.map((v, i) => ({ __label: String(i + 1), value: v }));
    return { rows, labelKey: '__label', seriesKeys: ['value'] };
  }

  const columns = Array.isArray(viewData.columns) ? viewData.columns : null;
  const allKeys = Object.keys(data[0] ?? {});
  const labelKey = columns?.[0] ?? viewData.labelKey ?? viewData.xKey ?? allKeys[0];
  let seriesKeys;
  if (Array.isArray(viewData.series) && viewData.series.length) {
    seriesKeys = viewData.series;
  } else if (columns && columns.length > 1) {
    seriesKeys = columns.slice(1);
  } else {
    seriesKeys = allKeys.filter((k) => k !== labelKey && typeof data[0][k] === 'number');
    if (!seriesKeys.length) seriesKeys = allKeys.filter((k) => k !== labelKey).slice(0, 1);
  }
  return { rows: data, labelKey, seriesKeys };
}

function ChartView({ data, renderDef }) {
  const viewData = renderDef?.data ?? {};
  const normalized = useMemo(() => normalizeChartData({ data, viewData }), [data, viewData]);

  if (!normalized || !normalized.rows.length || !normalized.seriesKeys.length) {
    return <p className="board-text-muted small mb-0">No chart data</p>;
  }

  const { rows, labelKey, seriesKeys } = normalized;
  const chartType = viewData.chartType ?? detectChartType(rows);
  const stacked = viewData.stacked === true;
  const showLegend = viewData.legend !== false && (seriesKeys.length > 1 || chartType === 'pie' || chartType === 'doughnut');
  const showGrid = viewData.grid !== false;

  let chart;
  if (chartType === 'pie' || chartType === 'doughnut') {
    const valueKey = seriesKeys[0];
    const inner = chartType === 'doughnut' ? '55%' : 0;
    chart = (
      <PieChart>
        <Pie
          data={rows}
          dataKey={valueKey}
          nameKey={labelKey}
          innerRadius={inner}
          outerRadius="80%"
          paddingAngle={1}
        >
          {rows.map((_, i) => (
            <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip />
        {showLegend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
      </PieChart>
    );
  } else if (chartType === 'line' || chartType === 'area') {
    const ChartC = chartType === 'area' ? AreaChart : LineChart;
    const SeriesC = chartType === 'area' ? Area : Line;
    chart = (
      <ChartC data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        {showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
        <XAxis dataKey={labelKey} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        {showLegend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
        {seriesKeys.map((key, i) => (
          <SeriesC
            key={key}
            type="monotone"
            dataKey={key}
            stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
            fill={CHART_PALETTE[i % CHART_PALETTE.length]}
            fillOpacity={chartType === 'area' ? 0.3 : 1}
            stackId={stacked ? 'stack' : undefined}
            dot={false}
          />
        ))}
      </ChartC>
    );
  } else if (chartType === 'scatter') {
    const xKey = labelKey;
    const yKey = seriesKeys[0];
    chart = (
      <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        {showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
        <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
        <YAxis dataKey={yKey} tick={{ fontSize: 10 }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={rows} fill={CHART_PALETTE[0]} />
      </ScatterChart>
    );
  } else {
    chart = (
      <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        {showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
        <XAxis dataKey={labelKey} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        {showLegend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
        {seriesKeys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            fill={CHART_PALETTE[i % CHART_PALETTE.length]}
            stackId={stacked ? 'stack' : undefined}
          />
        ))}
      </BarChart>
    );
  }

  const height = viewData.height ?? 220;
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        {chart}
      </ResponsiveContainer>
    </div>
  );
}

function FormView({ data, renderDef, onSave }) {
  const viewData = renderDef?.data ?? {};
  const schema = viewData.fields ?? {};
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const resolvedWriteValue = renderDef?.resolvedWriteValue;
  const discardLabel = viewData.discardLabel ?? 'Discard';
  const saveLabel = viewData.saveLabel ?? 'Save';
  const baseValues = useMemo(() => (
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data }
      : (resolvedWriteValue && typeof resolvedWriteValue === 'object' && !Array.isArray(resolvedWriteValue)
        ? { ...resolvedWriteValue }
        : {})
  ), [data, resolvedWriteValue]);

  const [journal, setJournal] = useState({});

  useEffect(() => {
    setJournal((current) => {
      const next = { ...current };
      Object.keys(next).forEach((key) => {
        if (deepEqual(next[key], baseValues[key])) delete next[key];
      });
      return next;
    });
  }, [baseValues]);

  const effectiveValues = useMemo(() => ({ ...baseValues, ...journal }), [baseValues, journal]);
  const dirty = Object.keys(journal).length > 0;

  const setFieldValue = useCallback((key, prop, rawValue) => {
    let nextValue = rawValue;
    if (prop.type === 'boolean') nextValue = !!rawValue;
    if (prop.type === 'number' || prop.type === 'integer') nextValue = rawValue === '' ? 0 : Number.parseFloat(rawValue);

    setJournal((current) => {
      const next = { ...current };
      if (deepEqual(nextValue, baseValues[key])) delete next[key];
      else next[key] = nextValue;
      return next;
    });
  }, [baseValues]);

  const handleSubmit = useCallback((event) => {
    event.preventDefault();
    onSave?.(effectiveValues, { kind: 'form', renderDef, writeTo: viewData.writeTo });
  }, [effectiveValues, onSave, renderDef, viewData.writeTo]);

  const handleDiscard = useCallback(() => {
    setJournal({});
  }, []);

  return (
    <form className="row g-2 h-100 align-content-start" onSubmit={handleSubmit}>
      {Object.entries(props).map(([key, prop]) => {
        const isRequired = required.includes(key);
        const compact = ['number', 'integer', 'boolean'].includes(prop.type) || prop.enum || prop.format === 'date';
        const value = effectiveValues[key];
        return (
          <div key={key} className={compact ? 'col-12 col-md-6' : 'col-12'}>
            {prop.type === 'boolean' ? (
              <div className="form-check mt-3">
                <input
                  id={`${renderDef?.id ?? 'field'}-${key}`}
                  type="checkbox"
                  className="form-check-input"
                  checked={!!value}
                  onChange={(event) => setFieldValue(key, prop, event.target.checked)}
                />
                <label className="form-check-label small" htmlFor={`${renderDef?.id ?? 'field'}-${key}`}>
                  {prop.title ?? key}
                </label>
              </div>
            ) : (
              <>
                <label className="form-label small mb-1 board-text-muted">{prop.title ?? key}</label>
                {prop.enum ? (
                  <select
                    className="form-select form-select-sm board-select"
                    value={value ?? ''}
                    onChange={(event) => setFieldValue(key, prop, event.target.value)}
                    required={isRequired}
                  >
                    {prop.enum.map((option) => (
                      <option key={String(option)} value={String(option)}>{String(option)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={prop.format === 'date' ? 'date' : (prop.type === 'number' || prop.type === 'integer' ? 'number' : 'text')}
                    className="form-control form-control-sm board-input"
                    value={prop.format === 'date' ? (value != null ? String(value).slice(0, 10) : '') : (value ?? '')}
                    min={prop.minimum}
                    max={prop.maximum}
                    step={prop.type === 'integer' ? '1' : (prop.type === 'number' ? 'any' : undefined)}
                    placeholder={prop.placeholder}
                    required={isRequired}
                    onChange={(event) => setFieldValue(key, prop, event.target.value)}
                  />
                )}
              </>
            )}
          </div>
        );
      })}
      <div className="col-12 mt-1">
        <button
          type="button"
          className={`btn btn-sm btn-outline-secondary board-button me-2${dirty ? '' : ' d-none'}`}
          onClick={handleDiscard}
        >
          {discardLabel}
        </button>
        <button type="submit" className={`btn btn-sm btn-primary board-button${dirty ? '' : ' d-none'}`}>
          {saveLabel}
        </button>
      </div>
    </form>
  );
}

function QueryView({ data, renderDef, onSave }) {
  const singleField = getSingleFieldConfig(renderDef, data);
  if (!singleField) {
    return <p className="board-text-muted small mb-0">No query field configured</p>;
  }

  const { fieldKey, prop, currentValue, isRequired, viewData } = singleField;
  const [journalValue, setJournalValue] = useState(currentValue ?? '');
  const buttonLabel = viewData.actionLabel ?? 'Search';

  useEffect(() => {
    setJournalValue(currentValue ?? '');
  }, [currentValue]);

  const handleSubmit = useCallback((event) => {
    event.preventDefault();
    let nextValue = journalValue;
    if (prop.type === 'number' || prop.type === 'integer') {
      nextValue = journalValue === '' ? '' : Number.parseFloat(journalValue);
    }
    onSave?.(
      buildEditorSaveValue(viewData.writeTo, fieldKey, nextValue),
      { kind: 'searchbox', renderDef, writeTo: viewData.writeTo },
    );
  }, [fieldKey, journalValue, onSave, prop.type, renderDef, viewData.writeTo]);

  const handleChange = useCallback((event) => {
    setJournalValue(event.target.value);
  }, []);

  return (
    <form className="input-group input-group-sm" onSubmit={handleSubmit}>
      <input
        type={prop.format === 'date' ? 'date' : (prop.type === 'number' || prop.type === 'integer' ? 'number' : 'search')}
        className="form-control board-input"
        value={prop.format === 'date' ? (journalValue != null ? String(journalValue).slice(0, 10) : '') : journalValue}
        min={prop.minimum}
        max={prop.maximum}
        step={prop.type === 'integer' ? '1' : (prop.type === 'number' ? 'any' : undefined)}
        placeholder={prop.placeholder ?? prop.title ?? fieldKey}
        aria-label={prop.title ?? fieldKey}
        required={isRequired}
        onChange={handleChange}
      />
      <button
        type="submit"
        className="btn btn-outline-secondary board-button"
        aria-label={buttonLabel}
        title={buttonLabel}
      >
        <i className="bi bi-search" aria-hidden="true" />
      </button>
    </form>
  );
}

function NotesView({ data, renderDef, onSave }) {
  const baseContent = typeof data === 'string' ? data : '';
  const [journal, setJournal] = useState(null);

  useEffect(() => {
    setJournal((current) => (current === baseContent ? null : current));
  }, [baseContent]);

  const dirty = journal != null;
  const effectiveContent = journal != null ? journal : baseContent;
  const handleChange = useCallback((event) => {
    const nextValue = event.target.value;
    setJournal(nextValue === baseContent ? null : nextValue);
  }, [baseContent]);
  const handleDiscard = useCallback(() => {
    setJournal(null);
  }, []);
  const handleSave = useCallback(() => {
    onSave?.(effectiveContent, { kind: 'notes', renderDef, writeTo: renderDef?.data?.writeTo });
  }, [effectiveContent, onSave, renderDef]);

  return (
    <div className="h-100 d-flex flex-column min-h-0">
      <textarea
        className="form-control form-control-sm board-textarea flex-grow-1"
        rows={8}
        placeholder="Write markdown..."
        value={effectiveContent}
        onChange={handleChange}
      />
      <div className="mt-2">
        <button
          type="button"
          className={`btn btn-sm btn-outline-secondary board-button me-2${dirty ? '' : ' d-none'}`}
          onClick={handleDiscard}
        >
          Discard
        </button>
        <button
          type="button"
          className={`btn btn-sm btn-primary board-button${dirty ? '' : ' d-none'}`}
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function EditableTableView({ data, renderDef, onSave }) {
  const viewData = renderDef?.data ?? {};
  const schemaProps = viewData.schema?.properties ?? {};
  const canAdd = viewData.addRow !== false;
  const canDelete = viewData.deleteRow !== false;
  const baseRows = useMemo(() => mergeRows(data), [data]);
  const [journalRows, setJournalRows] = useState(null);

  useEffect(() => {
    setJournalRows((current) => (Array.isArray(current) && deepEqual(current, baseRows) ? null : current));
  }, [baseRows]);

  const dirty = Array.isArray(journalRows);
  const effectiveRows = dirty ? mergeRows(journalRows) : mergeRows(baseRows);
  const columns = getObjectColumns(effectiveRows, viewData.columns);

  const updateRows = useCallback((nextRows) => {
    setJournalRows(deepEqual(nextRows, baseRows) ? null : mergeRows(nextRows));
  }, [baseRows]);

  const handleAddRow = useCallback(() => {
    const nextRow = {};
    columns.forEach((column) => {
      nextRow[column] = '';
    });
    updateRows([...effectiveRows, nextRow]);
  }, [columns, effectiveRows, updateRows]);

  const handleDiscard = useCallback(() => {
    setJournalRows(null);
  }, []);

  const handleSave = useCallback(() => {
    onSave?.(effectiveRows, { kind: 'editable-table', renderDef, writeTo: viewData.writeTo });
  }, [effectiveRows, onSave, renderDef, viewData.writeTo]);

  return (
    <div className="h-100 d-flex flex-column min-h-0">
      {(!columns.length && !canAdd) ? (
        <p className="board-text-muted small mb-0">{viewData.placeholder ?? 'No data'}</p>
      ) : (
        <div className="table-responsive flex-grow-1 min-h-0">
          <table className="table table-sm table-bordered mb-0 board-data-table">
            <thead>
              <tr>
                {columns.map((column) => <th key={column} className="small text-nowrap">{column}</th>)}
                {canDelete ? <th style={{ width: '2rem' }} /> : null}
              </tr>
            </thead>
            <tbody>
              {effectiveRows.length ? effectiveRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column) => {
                    const prop = schemaProps[column] ?? {};
                    const isNumber = prop.type === 'number' || prop.type === 'integer' || typeof row?.[column] === 'number';
                    return (
                      <td key={column} className="p-0">
                        <input
                          type={isNumber ? 'number' : 'text'}
                          className="form-control form-control-sm board-input border-0 rounded-0"
                          value={row?.[column] ?? ''}
                          step={isNumber ? 'any' : undefined}
                          onChange={(event) => {
                            const nextRows = mergeRows(effectiveRows);
                            nextRows[rowIndex][column] = isNumber
                              ? (event.target.value === '' ? 0 : Number.parseFloat(event.target.value))
                              : event.target.value;
                            updateRows(nextRows);
                          }}
                        />
                      </td>
                    );
                  })}
                  {canDelete ? (
                    <td className="text-center align-middle p-0">
                      <button
                        type="button"
                        className="btn btn-sm btn-link p-0"
                        style={{ color: 'var(--status-failed)' }}
                        title="Remove row"
                        onClick={() => updateRows(effectiveRows.filter((_, index) => index !== rowIndex))}
                      >
                        ✕
                      </button>
                    </td>
                  ) : null}
                </tr>
              )) : (
                <tr>
                  <td colSpan={columns.length + (canDelete ? 1 : 0)} className="board-text-muted small text-center">
                    {viewData.placeholder ?? 'No rows'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1">
        {canAdd ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary board-button me-1"
            onClick={handleAddRow}
          >
            + Add row
          </button>
        ) : null}
        <button
          type="button"
          className={`btn btn-sm btn-outline-secondary board-button me-1${dirty ? '' : ' d-none'}`}
          onClick={handleDiscard}
        >
          Discard
        </button>
        <button
          type="button"
          className={`btn btn-sm btn-primary board-button${dirty ? '' : ' d-none'}`}
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function TodoView({ data, renderDef, onSave }) {
  const baseItems = useMemo(() => mergeRows(data), [data]);
  const [state, setState] = useState({ currentState: baseItems, pending: mergeRows(baseItems) });

  useEffect(() => {
    setState((current) => {
      const dirty = !deepEqual(current.currentState, current.pending);
      return {
        currentState: baseItems,
        pending: dirty ? current.pending : mergeRows(baseItems),
      };
    });
  }, [baseItems]);

  const save = useCallback((nextPending) => {
    setState({ currentState: mergeRows(nextPending), pending: mergeRows(nextPending) });
    onSave?.(nextPending, { kind: 'todo', renderDef, writeTo: renderDef?.data?.writeTo });
  }, [onSave, renderDef]);

  return (
    <div className="h-100 d-flex flex-column min-h-0">
      <div className="flex-grow-1 overflow-auto">
        {state.pending.map((item, index) => (
          <div key={index} className="d-flex align-items-center gap-2 py-2 border-bottom">
            <input
              className="form-check-input flex-shrink-0"
              type="checkbox"
              checked={!!item.done}
              onChange={(event) => {
                const next = mergeRows(state.pending);
                next[index].done = event.target.checked;
                save(next);
              }}
            />
            <span className={`small flex-grow-1${item.done ? ' text-decoration-line-through text-muted' : ''}`}>{item.text}</span>
            <button
              type="button"
              className="btn btn-sm btn-link p-0"
              style={{ color: 'var(--status-failed)' }}
              title="Remove"
              onClick={() => save(state.pending.filter((_, itemIndex) => itemIndex !== index))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <TodoComposer
        onAdd={(text) => {
          const next = [...state.pending, { text, done: false }];
          save(next);
        }}
      />
    </div>
  );
}

function TodoComposer({ onAdd }) {
  const [value, setValue] = useState('');

  return (
    <div className="input-group input-group-sm mt-2">
      <input
        type="text"
        className="form-control board-input"
        placeholder="Add item..."
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const text = value.trim();
          if (!text) return;
          onAdd(text);
          setValue('');
        }}
      />
      <button
        type="button"
        className="btn btn-outline-secondary board-button"
        onClick={() => {
          const text = value.trim();
          if (!text) return;
          onAdd(text);
          setValue('');
        }}
      >
        +
      </button>
    </div>
  );
}

function AlertView({ data, renderDef }) {
  const thresholds = renderDef?.data?.thresholds ?? {};
  const value = typeof data === 'number' ? data : (data?.value ?? null);

  let level = 'unknown';
  let tone = 'board-tone--unknown';
  if (value != null) {
    if (thresholds.green && evalThreshold(value, thresholds.green)) {
      level = 'green';
      tone = 'board-tone--green';
    } else if (thresholds.amber && evalThreshold(value, thresholds.amber)) {
      level = 'amber';
      tone = 'board-tone--amber';
    } else {
      level = 'red';
      tone = 'board-tone--red';
    }
  }

  return (
    <div className={`board-alert ${tone}`}>
      <span className="board-alert__dot" />
      <div className="flex-grow-1">
        <div className="board-alert__value">{value != null ? String(value) : '—'}</div>
        {renderDef?.label ? <div className="board-alert__label">{renderDef.label}</div> : null}
      </div>
      <span className={`board-badge ${tone}`}>{level}</span>
    </div>
  );
}

function NarrativeView({ data }) {
  const text = typeof data === 'string' ? data : (data?.text ?? '');
  if (!text) {
    return <p className="board-text-muted small fst-italic mb-0">No narrative yet. Click refresh to generate.</p>;
  }
  return <div className="small">{text}</div>;
}

function BadgeView({ data, renderDef }) {
  const colorMap = renderDef?.data?.colorMap ?? {};
  const value = data != null ? String(data) : '';
  const toneKey = colorMap[value] ?? 'secondary';
  const toneMap = {
    green: 'board-tone--green',
    amber: 'board-tone--amber',
    red: 'board-tone--red',
    blue: 'board-tone--running',
    primary: 'board-tone--running',
    success: 'board-tone--green',
    warning: 'board-tone--amber',
    danger: 'board-tone--red',
    secondary: 'board-tone--secondary',
  };
  const tone = toneMap[toneKey] ?? `board-tone--${toneKey}`;
  return <span className={`board-badge ${tone}`}>{value}</span>;
}

function TextView({ data, renderDef }) {
  const viewData = renderDef?.data ?? {};
  const format = viewData.format ?? 'default';
  const style = renderDef?.style ?? viewData.style ?? 'default';
  const hideIfEmpty = viewData.hideIfEmpty ?? renderDef?.hideIfEmpty;

  if (hideIfEmpty && (data == null || data === '')) return null;

  if (format === 'file-links') {
    if (!Array.isArray(data) || data.length === 0) {
      return <div className="board-text-muted small">No files uploaded</div>;
    }
    return (
      <div>
        {data.map((file, index) => {
          if (!file?.stored_name) return null;
          const name = file.name ?? file.stored_name;
          const size = file.size ? ` (${Math.round(file.size / 1024)}KB)` : '';
          const href = renderDef?.fileUrlForIndex?.(index, file);
          return (
            <div key={`${file.stored_name}-${index}`} className="mb-2">
              {href ? (
                <a href={href} className="btn btn-sm btn-outline-secondary board-file-link">{name}{size}</a>
              ) : (
                <span className="btn btn-sm btn-outline-secondary board-file-link disabled">{name}{size}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const Tag = style === 'heading' ? 'h4' : 'div';
  const className = style === 'muted'
    ? 'board-text-muted small'
    : style === 'muted-italic'
      ? 'board-text-muted small fst-italic'
      : style === 'heading'
        ? 'fw-bold'
        : 'small';
  return <Tag className={className}>{data != null ? String(data) : ''}</Tag>;
}

function MarkdownView({ data }) {
  let text = '';
  if (typeof data === 'string') text = data;
  else if (data && typeof data === 'object' && data.text) text = data.text;
  else if (data != null) text = JSON.stringify(data, null, 2);
  if (!text) return null;

  const normalizedText = text
    .replace(/\s*\[(\d+)\]\((https?:\/\/[^)]+)\)/g, '')
    .replace(/\s+$/gm, '')
    .trim();

  if (!normalizedText) return null;

  return (
    <div className="small mb-0 markdown-body lh-sm board-markdown" style={{ color: 'var(--color-text)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...props }) => <h1 className="h5 fw-bold mb-2 pb-1 border-bottom" {...props} />,
          h2: ({ node, ...props }) => <h2 className="fs-6 fw-bold text-uppercase board-text-soft mb-2 mt-3" {...props} />,
          h3: ({ node, ...props }) => <h3 className="fs-6 fw-semibold mb-2 mt-2" {...props} />,
          h4: ({ node, ...props }) => <h4 className="small fw-semibold mb-1 mt-2" {...props} />,
          h5: ({ node, ...props }) => <h5 className="small fw-semibold mb-1 mt-2" {...props} />,
          h6: ({ node, ...props }) => <h6 className="small fw-semibold board-text-soft mb-1 mt-2" {...props} />,
          p: ({ node, ...props }) => <p className="mb-1" {...props} />,
          ul: ({ node, ...props }) => <ul className="mb-1 ps-3" {...props} />,
          ol: ({ node, ...props }) => <ol className="mb-1 ps-3" {...props} />,
          li: ({ node, ...props }) => <li className="mb-1" {...props} />,
          a: ({ node, ...props }) => <a className="link-primary text-decoration-none" target="_blank" rel="noreferrer" {...props} />,
          blockquote: ({ node, ...props }) => <blockquote className="border-start border-3 ps-2 board-text-muted fst-italic my-2" style={{ borderColor: 'var(--color-border-strong)' }} {...props} />,
          hr: ({ node, ...props }) => <hr className="my-2 opacity-25" {...props} />,
          strong: ({ node, ...props }) => <strong className="fw-semibold" {...props} />,
          code: ({ inline, className, children, ...props }) => (
            inline ? (
              <code className="board-code rounded px-1 py-0" style={{ background: 'rgba(255, 255, 255, 0.06)' }} {...props}>{children}</code>
            ) : (
              <code className={`${className ?? ''} board-code small`.trim()} {...props}>{children}</code>
            )
          ),
          pre: ({ node, ...props }) => <pre className="board-code-block p-2 mb-2 overflow-auto" style={{ lineHeight: 1.4 }} {...props} />,
          table: ({ node, ...props }) => (
            <div className="table-responsive my-2">
              <table className="table table-sm table-striped align-middle mb-0 board-data-table" {...props} />
            </div>
          ),
          thead: ({ node, ...props }) => <thead {...props} />,
          img: ({ node, ...props }) => <img className="img-fluid rounded my-2" style={{ border: '1px solid var(--color-border)' }} loading="lazy" {...props} />,
        }}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}

function ActionsView({ data, renderDef, onSave }) {
  const buttons = renderDef?.data?.buttons ?? (Array.isArray(data) ? data : []);
  if (!buttons.length) return null;

  return (
    <div className="d-flex gap-2 flex-wrap">
      {buttons.map((button) => (
        <button
          key={button.id}
          type="button"
          className={`btn btn-${button.style ?? 'outline-secondary'} btn-${button.size ?? 'sm'} board-action-button`}
          disabled={!!button.disabled}
          onClick={() => onSave?.(null, { kind: 'actions', renderDef, buttonId: button.id, elemId: renderDef?.id })}
        >
          {button.label ?? button.id}
        </button>
      ))}
    </div>
  );
}

export function CardCoreView({ kind, renderDef, data, onSave }) {
  const effectiveKind = normalizeLegacyKind(kind, renderDef, data);
  const viewEntry = CARD_CORE_VIEW_KINDS[effectiveKind] ?? CARD_CORE_VIEW_KINDS.text;
  const ViewComponent = viewEntry.Component;
  const viewData = CARD_CORE_VIEW_KINDS[effectiveKind]
    ? data
    : (typeof data === 'string' ? data : (data != null ? JSON.stringify(data, null, 2) : ''));
  const body = <ViewComponent data={viewData} renderDef={renderDef} onSave={onSave} />;

  return (
    <div className="w-100 d-flex flex-column">
      <CardFrame label={renderDef?.label} kind={effectiveKind}>
        {body}
      </CardFrame>
    </div>
  );
}