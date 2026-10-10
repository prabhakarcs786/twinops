import { useEffect, useState } from 'react';
import { fetchReports, type EvaluationReport } from '../api/live.ts';

const suiteKey = (r: EvaluationReport) => `${r.pack} · ${(r.variant ?? 'standard').replaceAll('_', ' ')} · seeds ${r.startSeed}–${r.startSeed + r.seeds - 1} · ${r.suiteVersion}`;

export function BenchmarkPanel() {
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchReports().then((rows) => {
      if (alive) { setReports(rows.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))); setError(''); }
    }).catch(() => { if (alive) setError('Evaluation reports are unavailable. Retry when the backend is connected.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refresh]);
  const suites = [...new Set(reports.map(suiteKey))];
  const suite = suites.includes(selected) ? selected : suites[0];
  // Compare like with like: same pack, seed range and evaluation version.
  const seen = new Set<string>();
  const matching = reports.filter((r) => {
    const key = `${r.planner.kind}:${r.planner.provider}:${r.planner.model}`;
    if (suiteKey(r) !== suite || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const paired = matching.some((r) => r.planner.kind === 'runbook') && matching.some((r) => r.planner.kind === 'llm');
  return (
    <details className="benchmark-panel">
      <summary>Measured AI value · runbook and model evaluation</summary>
      <p>Same scenarios, same seeds, same gate. Success without fallback separates the evaluated planner’s result from a rescued run.</p>
      <div className="benchmark-controls">
        {!!suites.length && <label>Evaluation suite<select value={suite} onChange={(e) => setSelected(e.target.value)}>{suites.map((s) => <option key={s}>{s}</option>)}</select></label>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => { setLoading(true); setRefresh((n) => n + 1); }}>{loading ? 'Loading reports…' : 'Refresh reports'}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !reports.length && <p>No evaluation report has been published yet.</p>}
      {!!matching.length && !paired && <p className="recovery-notice">Only one planner is available for this suite. A comparison is not yet established.</p>}
      {matching.map((report) => <section key={report.name} className="benchmark-report" aria-label={`${report.planner.kind} evaluation`}>
        <h3>{report.planner.kind === 'runbook' ? 'Deterministic runbook' : `${report.planner.provider} · ${report.planner.model}`}</h3>
        <p className="muted">Measured {new Date(report.generatedAt).toLocaleString()} · {report.seeds} run{report.seeds === 1 ? '' : 's'} per fault · {report.planner.version}</p>
        <div className="table-wrap" role="region" aria-label={`${report.planner.kind} results`} tabIndex={0}>
          <table className="diff"><caption className="sr-only">Recorded evaluation results</caption>
            <thead><tr><th scope="col">Fault</th><th scope="col">Expected verdict</th><th scope="col">Success without fallback</th><th scope="col">Unsafe passed</th><th scope="col">Abstentions</th><th scope="col">Median / p95 compute</th><th scope="col">Tokens</th><th scope="col">Fallback calls</th></tr></thead>
            <tbody>{Object.entries(report.byFault).map(([fault, r]) => <tr key={fault}><th scope="row">{fault.replaceAll('_', ' ')}</th><td>{r.verdictOk}/{r.runs}</td><td>{r.fallbackFreeSuccess === undefined ? 'Not measured' : `${r.fallbackFreeSuccess}/${r.runs}`}</td><td>{r.unsafePassed}</td><td>{r.abstentions ?? 'Not measured'}</td><td>{(r.medianComputeMs / 1000).toFixed(2)} s / {r.p95ComputeMs === undefined ? 'Not measured' : `${(r.p95ComputeMs / 1000).toFixed(2)} s`}</td><td>{r.tokens.toLocaleString()}</td><td>{r.fallbacks}</td></tr>)}</tbody>
          </table>
        </div>
        <ul className="control-results">{report.controls.map((c) => <li key={c.id}><strong>{c.id}: {c.ok ? 'Passed' : 'Failed'}</strong> · {c.name ?? 'Adverse control'} · {c.scope === 'gateway' ? 'gateway control / runbook fixture' : c.scope ? `planner + gate / ${c.planner?.provider ?? c.planner?.kind}` : 'legacy report / planner attribution not recorded'}{c.fallbacks ? ` · ${c.fallbacks} fallback calls` : ''}</li>)}</ul>
        <p className="muted">{report.note} {report.seeds < 10 ? 'Small sample: use this as a smoke check, not an estimate of general accuracy.' : ''}</p>
      </section>)}
    </details>
  );
}
