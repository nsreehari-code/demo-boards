import React from 'react';

export function IdentityCard({ card }) {
  const { identity, managerLine } = card?.computed_values ?? {};
  const manager = (managerLine ?? '').replace(/\*\*/g, '').replace(/^Manager:\s*/i, '');

  if (!identity && !manager) {
    return <p className="text-muted small mb-0">No identity data yet.</p>;
  }
  return (
    <div className="small">
      {identity && <p className="mb-1 fw-semibold">{identity}</p>}
      {manager && (
        <p className="mb-0 text-muted"><strong>Manager:</strong> {manager}</p>
      )}
    </div>
  );
}
