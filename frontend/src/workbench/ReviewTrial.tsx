import { ArrowLeft, CheckSquare2, Download, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { fetchReviewSummary, finishReview, getIncident, reviewExportUrl, startReview, type LiveIncident, type ReviewDecision, type ReviewMode, type ReviewResult, type ReviewStarted, type ReviewSummary } from '../api/live.ts';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import { describeStep } from '../engine/catalogue.ts';
import { fmtClock } from './usePlayback.ts';

export function ReviewMetrics({ revision = '' }: { revision?: string }) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    fetchReviewSummary().then((result) => { if (active) { setSummary(result); setError(''); } })
      .catch(() => { if (active) setError('Review measurements are unavailable.'); });
    return () => { active = false; };
  }, [refresh, revision]);
  return <details className="review-metrics">
    <summary>Operator review measurements</summary>
    <div className="review-metrics-actions">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRefresh((count) => count + 1)}><RefreshCw size={14} aria-hidden="true" />Refresh measurements</button>
      <a className="btn btn-ghost btn-sm" href={reviewExportUrl}><Download size={14} aria-hidden="true" />Export trials</a>
    </div>
    {error && <p role="alert">{error}</p>}
    {!summary && !error && <p role="status">Loading measurements...</p>}
    {summary && <>
      <p>{summary.totalTrials} completed trials; {summary.pairedTasks} candidate tasks reviewed in both conditions.</p>
      {!summary.pairedTasks ? <p className="muted">No matched-task comparison yet. Productivity improvement has not been established.</p>
        : <div className="table-wrap" role="region" aria-label="Matched review measurements" tabIndex={0}><table className="diff">
          <caption className="sr-only">Results for identical incident and candidate tasks only</caption>
          <thead><tr><th scope="col">Evidence condition</th><th scope="col">Trials</th><th scope="col">Median review time</th><th scope="col">Gate agreement</th></tr></thead>
          <tbody>{summary.modes.map((mode) => <tr key={mode.mode}><th scope="row">{mode.mode === 'raw' ? 'Raw observations' : 'Proof Pack'}</th><td>{mode.trials}</td><td>{mode.medianMs === null ? 'Not measured' : fmtClock(mode.medianMs)}</td><td>{mode.gateAgreements}/{mode.trials}</td></tr>)}</tbody>
        </table></div>}
      <p className="muted">{summary.note}</p>
    </>}
  </details>;
}

export function ReviewTrial({ theme, onToggleTheme }: { theme: 'dark' | 'light'; onToggleTheme: () => void }) {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const incidentId = params.get('incident') ?? '';
  const assignmentId = params.get('assignment') ?? undefined;
  const [detail, setDetail] = useState<LiveIncident | null>(null);
  const [candidateId, setCandidateId] = useState(params.get('candidate') ?? '');
  const [mode, setMode] = useState<ReviewMode>(params.get('mode') === 'proof' ? 'proof' : 'raw');
  const [trial, setTrial] = useState<ReviewStarted | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [decision, setDecision] = useState<ReviewDecision | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const run = detail?.run;
  const candidate = run?.candidates.find((item) => item.change.id === (candidateId || run.candidates[0]?.change.id));
  const back = `/workbench?incident=${encodeURIComponent(incidentId)}`;

  useEffect(() => {
    let active = true;
    if (!incidentId) return;
    getIncident(incidentId).then((incident) => { if (active) setDetail(incident); })
      .catch(() => { if (active) setError('This saved incident could not be loaded.'); });
    return () => { active = false; };
  }, [incidentId]);
  useEffect(() => {
    if (!trial || result) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    document.getElementById('review-evidence')?.focus();
    return () => window.clearInterval(timer);
  }, [trial, result]);

  const begin = async () => {
    if (!candidate) return;
    setBusy(true);
    setError('');
    try { setTrial(await startReview(incidentId, candidate.change.id, mode, assignmentId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Trial could not start.'); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trial || !decision) return;
    setBusy(true);
    setError('');
    try { setResult(await finishReview(trial.trialId, decision)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Decision could not be recorded.'); }
    finally { setBusy(false); }
  };

  return <div className="wb">
    <SiteHeader variant="app" theme={theme} onToggleTheme={onToggleTheme} />
    <main id="main" className="review-page" tabIndex={-1}>
      <header className="review-intro"><p className="stage-kicker">{assignmentId ? 'Assigned operator trial' : 'Anonymous operator trial'}</p><h1>Review the evidence.</h1><StatusChip tone="info">Read-only study, not approval</StatusChip></header>
      <a className="evidence-link" href={incidentId ? back : '/workbench'}><ArrowLeft size={14} aria-hidden="true" />Return to investigation</a>
      {error && <p className="recovery-notice" role="alert">{error}</p>}
      {!incidentId && <p>No incident was selected.</p>}
      {incidentId && !detail && !error && <p role="status">Loading saved evidence...</p>}
      {detail && !candidate && <p>No tested candidate is available for review.</p>}
      {run && candidate && <>
        {!trial && <section className="review-setup" aria-label="Review setup">
          {assignmentId && <p>Your task and evidence condition are assigned. Complete this review once, in the provided order.</p>}
          <label className="field"><span>Candidate task</span><select disabled={Boolean(assignmentId)} value={candidate.change.id} onChange={(event) => setCandidateId(event.target.value)}>{run.candidates.map((item) => <option key={item.change.id} value={item.change.id}>{item.change.id}</option>)}</select></label>
          <fieldset className="review-modes" disabled={Boolean(assignmentId)}><legend>Evidence condition</legend>
            <label><input type="radio" name="review-mode" value="raw" checked={mode === 'raw'} onChange={() => setMode('raw')} />Raw observations</label>
            <label><input type="radio" name="review-mode" value="proof" checked={mode === 'proof'} onChange={() => setMode('proof')} />Proof Pack</label>
          </fieldset>
          <button type="button" className="btn btn-primary" onClick={() => void begin()} disabled={busy}><Play size={16} aria-hidden="true" />{busy ? 'Starting...' : 'Start timed review'}</button>
        </section>}
        {trial && !result && <>
          <div className="review-clock"><StatusChip tone="info">{mode === 'raw' ? 'Raw observations' : 'Proof Pack'}</StatusChip><span aria-label="Review elapsed time">{fmtClock(Math.max(0, now - trial.startedAt * 1000))}</span></div>
          <section id="review-evidence" tabIndex={-1} aria-label="Review evidence" className="review-evidence">
            <h2>{candidate.change.label}</h2>
            <ul className="memory-steps">{candidate.change.steps.map((step) => <li key={describeStep(step)}><code>{describeStep(step)}</code></li>)}</ul>
            {mode === 'raw' ? <div className="trial-raw">
              <h3>Observed probes</h3><ul className="trial-observations">{run.observation.probes.map((probe) => <li key={probe.id}><strong>{probe.id}: {probe.label}</strong><p>{probe.detail}</p></li>)}</ul>
              <details><summary>Change history</summary><ul className="trial-observations">{run.observation.changes.map((change) => <li key={change.id}><strong>{change.id}</strong>: {change.summary}</li>)}</ul></details>
              <details><summary>Logs (untrusted data)</summary><ul className="trial-observations">{run.observation.logs.map((log) => <li key={log.id}><strong>{log.id}</strong>: {log.text}</li>)}</ul></details>
              {(run.observation.evidenceGaps ?? []).map((gap) => <p className="recovery-notice" key={gap}>{gap}</p>)}
            </div> : <div className="trial-proof">
              <h3>Candidate test evidence</h3>
              <ul className="trial-gates">{candidate.gates.filter((gate) => gate.id !== 'G8').map((gate) => <li key={gate.id}><strong>{gate.id}</strong><StatusChip tone={gate.status === 'pass' ? 'ok' : gate.status === 'warn' ? 'warn' : 'info'}>{gate.status}</StatusChip><span>{gate.reason}</span></li>)}</ul>
              <h3>Untested conditions</h3><ul className="untested">{run.untested.map((limit) => <li key={limit}>{limit}</li>)}</ul>
            </div>}
          </section>
          <form onSubmit={(event) => void submit(event)} className="review-decision">
            <fieldset><legend>Your review decision</legend>
              {(['accept', 'reject', 'more_evidence'] as const).map((option) => <label key={option}><input type="radio" name="decision" value={option} checked={decision === option} onChange={() => setDecision(option)} required />{option === 'accept' ? 'Accept proposal' : option === 'reject' ? 'Reject proposal' : 'Need more evidence'}</label>)}
            </fieldset>
            <button className="btn btn-primary" type="submit" disabled={!decision || busy}><CheckSquare2 size={16} aria-hidden="true" />{busy ? 'Recording...' : 'Record review'}</button>
          </form>
        </>}
        {result && <section className="review-result" aria-label="Recorded review" role="status">
          <h2>Review recorded</h2><p>{fmtClock(result.elapsedMs)} server-measured review time</p>
          <StatusChip tone={result.gateAgreement ? 'ok' : 'warn'}>{result.gateAgreement ? 'Agrees with the recorded gate' : 'Differs from the recorded gate'}</StatusChip>
          <p>No approval or network change was made. This measures gate agreement, not production safety.</p>
          <a className="btn btn-ghost" href={back}>Back to the incident</a>
        </section>}
      </>}
      <ReviewMetrics revision={result?.trialId} />
    </main>
  </div>;
}
