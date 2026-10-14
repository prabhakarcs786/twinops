import { History, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchHistory, type IncidentSummary } from '../api/live.ts';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';

const STATE: Record<string, [ChipTone, string]> = {
  running: ['twin', 'Investigating'],
  awaiting_approval: ['pending', 'Awaiting approval'],
  applying: ['pending', 'Applying'],
  escalated: ['warn', 'Escalated to on-call'],
  failed: ['fail', 'Run failed'],
  recovery_required: ['fail', 'Recovery required'],
  applied: ['ok', 'Fixed · verified'],
  rolled_back: ['warn', 'Rolled back'],
  expired: ['skip', 'Expired · not applied'],
  rejected_by_operator: ['skip', 'Rejected by operator'],
  refused: ['fail', 'Refused'],
};

const words = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(seconds: number) {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return relative.format(-Math.floor(diff / 60), 'minute');
  if (diff < 86_400) return relative.format(-Math.floor(diff / 3600), 'hour');
  return relative.format(-Math.floor(diff / 86_400), 'day');
}

export function IncidentHistory({ onResume, disabled, current }: { onResume: (id: string) => void; disabled: boolean; current?: string | null }) {
  const [rows, setRows] = useState<IncidentSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try { setRows(await fetchHistory()); } catch { setError('Could not load saved incidents. Try again when the backend is available.'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  return (
    <section ref={root} className="history" aria-label="Saved incidents">
      <button ref={toggle} type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls="history-panel" onClick={() => { setOpen(!open); if (!open) void refresh(); }}>
        <History size={15} aria-hidden="true" /> Recent incidents
      </button>
      {open && <div id="history-panel" className="history-content">
        <div className="history-head">
          <div>
            <h2>Recent incidents</h2>
            <p>Open one to inspect its evidence. Restarted investigations need fresh verification before approval.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading} aria-label="Refresh history">
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'spin' : undefined} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!loading && !error && !rows.length && <p className="history-empty">No saved incidents yet. Start a live investigation to create one.</p>}
        <ul className="history-list">{rows.map((row) => {
          const [tone, label] = STATE[row.outcome ?? row.status] ?? ['info', words(row.outcome ?? row.status)];
          const isCurrent = row.incidentId === current;
          return <li key={row.incidentId}>
            <button type="button" className={isCurrent ? 'is-current' : undefined} aria-current={isCurrent ? 'true' : undefined} disabled={disabled} onClick={() => { setOpen(false); onResume(row.incidentId); }}>
              <span className="history-top">
                <StatusChip tone={tone}>{label}</StatusChip>
                <span className="history-when">
                  {isCurrent && <span className="history-viewing">Viewing</span>}
                  <time dateTime={new Date(row.createdAt * 1000).toISOString()} title={new Date(row.createdAt * 1000).toLocaleString()}>{ago(row.createdAt)}</time>
                </span>
              </span>
              <strong className="history-cause">{row.cause ?? (row.verdict ? words(row.verdict) : 'Investigation')}</strong>
              {row.fix && <span className="history-fix">Fix: {row.fix}{row.reused && <span className="history-reused"> · reused from an earlier incident</span>}</span>}
              <span className="history-meta">
                {row.journeys ? <span>{row.affected}/{row.journeys} journeys down</span> : null}
                {row.verdictMs != null && <span>verdict in {duration(row.verdictMs)}</span>}
                {row.restoredMs != null && <span>restored in {duration(row.restoredMs)}</span>}
                {row.verdict && <span>Proof Gate: {words(row.verdict)}</span>}
              </span>
              <code>{row.incidentId}</code>
            </button>
          </li>;
        })}</ul>
      </div>}
    </section>
  );
}
