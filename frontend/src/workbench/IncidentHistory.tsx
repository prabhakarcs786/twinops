import { useState } from 'react';
import { fetchHistory, type IncidentSummary } from '../api/live.ts';

export function IncidentHistory({ onResume, disabled }: { onResume: (id: string) => void; disabled: boolean }) {
  const [rows, setRows] = useState<IncidentSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setLoading(true);
    setError('');
    try { setRows(await fetchHistory()); } catch { setError('Could not load saved incidents. Try again when the backend is available.'); }
    finally { setLoading(false); }
  };
  return (
    <section className="history" aria-label="Saved incidents">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh(); }}>Recent incidents</button>
      {open && <div className="history-content">
        <p className="muted">Resume an active investigation or inspect saved evidence. Restarted investigations require fresh verification before approval.</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>{loading ? 'Loading…' : 'Refresh history'}</button>
        {error && <p role="alert">{error}</p>}
        {!loading && !error && !rows.length && <p>No saved incidents yet. Start a live investigation to create one.</p>}
        <ul>{rows.map((row) => <li key={row.incidentId}>
          <button type="button" disabled={disabled} onClick={() => onResume(row.incidentId)}>
            <strong>{row.verdict?.replaceAll('_', ' ') ?? 'Investigation'}</strong>
            <span>{row.pack} · {(row.outcome ?? row.status).replaceAll('_', ' ')} · {new Date(row.createdAt * 1000).toLocaleString()}</span>
            <code>{row.incidentId}</code>
          </button>
        </li>)}</ul>
      </div>}
    </section>
  );
}
