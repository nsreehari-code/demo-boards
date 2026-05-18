import React from 'react';

export function IncomeCard({ card }) {
  const rows = card?.computed_values?.rows ?? [];

  if (!rows.length) {
    return <p className="text-muted small mb-0">No data yet.</p>;
  }

  const cols = Object.keys(rows[0]);

  return (
    <div>
      <p className="small text-muted mb-2">Latest Fiscal Total Income</p>
      <table className="table table-sm table-hover mb-0">
        <thead>
          <tr>{cols.map(c => <th key={c} className="small">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c} className="small">
                  {typeof row[c] === 'number' ? row[c].toLocaleString() : String(row[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
