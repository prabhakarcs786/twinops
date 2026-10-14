import type { IncidentLifecycle } from '../api/contracts.ts';
import { describeStep } from '../engine/catalogue.ts';
import { StatusChip } from '../components/StatusChip.tsx';
import type { RunView } from './runView.ts';

export function DecisionReview({ view, lifecycle }: { view: RunView; lifecycle?: IncidentLifecycle }) {
  const { run } = view;
  const selected = run.selected;
  const coverage = run.reproduction.coverage;
  const snapshot = run.snapshot;
  const sources = [...run.observation.probes, ...run.diagnostics];
  const measured = sources.filter((p) => p.provenance?.classification === 'measured').length;
  return <section className="decision-review" aria-labelledby="decision-review-title">
    <div className="section-caption"><div><p className="stage-kicker">Operator review</p><h2 id="decision-review-title">What supports this decision?</h2></div>
      {lifecycle && <StatusChip tone={lifecycle.canApprove ? 'ok' : 'info'}>{lifecycle.nextAction}</StatusChip>}
    </div>
    <div className="decision-review-grid">
      <article><h3>Proposed change</h3>{selected ? <><p>{selected.change.rationale}</p><ul>{selected.change.steps.map((step, i) => <li key={i}><code>{describeStep(step)}</code></li>)}</ul>
        <p>{selected.touched.length} device(s) affected · rollback {selected.rollback.matches ? 'rehearsed' : 'unverified'}</p></> : <p>No change is ready for approval. Review the missing evidence below.</p>}</article>
      <article><h3>Evidence source</h3>{snapshot ? <><p><strong>{measured}</strong> measured results · <strong>{sources.length - measured}</strong> model-derived or other results</p>
        <p>Collected <time dateTime={snapshot.collectedAt}>{new Date(snapshot.collectedAt).toLocaleString()}</time></p>
        <p>{snapshot.consistent ? 'Target state stayed consistent during capture.' : 'Capture is inconsistent.'}</p>
        {lifecycle && !lifecycle.evidenceFresh && <p className="approval-warn">Evidence expired. Start a fresh investigation.</p>}</> : <p>This offline demonstration has no live evidence provenance.</p>}</article>
      <article><h3>Verification coverage</h3>{coverage ? <><p>{coverage.testedJourneys.length} journeys · {coverage.representedNodes.length}/{coverage.totalNodes} nodes represented</p>
        <p>{run.reproduction.matched}/{run.reproduction.total} compared symptoms reproduced.</p>
        {coverage.missingCritical.length > 0 && <ul>{coverage.missingCritical.map((item) => <li key={item}>{item}</li>)}</ul>}</> : <p>{run.reproduction.matched}/{run.reproduction.total} symptoms reproduced in the demonstration model.</p>}
        <p>{run.investigation?.stopReason}</p></article>
      <article><h3>Remaining uncertainty</h3><ul>{run.untested.map((item) => <li key={item}>{item}</li>)}</ul></article>
    </div>
    {run.investigation && <details className="diagnostic-evidence"><summary>Inspect the investigation · {run.investigation.rounds.length} read-only diagnostics</summary>
      <ol>{run.investigation.rounds.map((step) => <li key={step.round}><strong>{step.question}</strong><p>{step.evidence.detail}</p>
        <p className="muted">{step.evidence.provenance?.classification} · {step.evidence.provenance?.source} · {step.evidence.id}</p>
        {step.hypothesisBefore !== step.hypothesisAfter && <p>Leading hypothesis changed to {step.hypothesisAfter.replaceAll('_', ' ')}.</p>}</li>)}</ol>
    </details>}
  </section>;
}
