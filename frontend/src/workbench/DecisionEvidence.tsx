import { useState } from 'react';
import { StatusChip } from '../components/StatusChip.tsx';
import type { CandidateRecord, Frame, Observation, RunEvent } from '../engine/types.ts';
import type { RunView } from './runView.ts';
import { fmtClock } from './usePlayback.ts';

const FACT_GROUPS = ['Observed', 'Hypotheses', 'Test results', 'Limits'] as const;

export function EvidenceFacts({ view, frame, observation, ready, sources, backend }: { view: RunView | null; frame: Frame; observation?: Observation; ready: boolean; sources: Map<string, string>; backend?: string }) {
  const [group, setGroup] = useState<typeof FACT_GROUPS[number]>('Observed');
  const selected = ready ? view?.run.selected : null;
  const limits = [...(observation?.evidenceGaps ?? []), ...(ready ? view?.run.untested ?? [] : [])];
  const rows = group === 'Observed'
    ? (observation?.probes ?? []).map((probe) => ({ id: probe.id, title: probe.label, detail: probe.detail, references: [probe.id], label: probe.ok ? 'Probe passed' : 'Probe failed' }))
    : group === 'Hypotheses'
      ? frame.hypotheses.map((hypothesis) => ({ id: hypothesis.id, title: hypothesis.title, detail: hypothesis.rationale,
        references: [...new Set([...hypothesis.supporting, ...hypothesis.contradicting])], label: 'Interpretation, not confirmed' }))
      : group === 'Test results'
        ? (selected?.gates ?? []).filter((gate) => gate.id !== 'G8').map((gate) => ({ id: gate.id, title: `${selected!.change.label} / ${gate.id}`,
          detail: gate.reason, references: [selected!.change.id, gate.id], label: `Gate ${gate.status}` }))
        : limits.map((limit, index) => ({ id: `LIMIT-${index + 1}`, title: `Scope limit ${index + 1}`, detail: limit, references: [], label: 'Not established' }));
  return <div className="facts-panel">
    <div className="facts-heading"><h3>What the evidence establishes</h3><StatusChip tone="info">{backend === 'emulated' ? 'Emulated lab' : 'Model twin'}</StatusChip></div>
    <div className="segmented facts-filter" role="group" aria-label="Evidence category">
      {FACT_GROUPS.map((category) => <button key={category} type="button" aria-pressed={group === category} className={group === category ? 'is-on' : ''} onClick={() => setGroup(category)}>{category}</button>)}
    </div>
    {group === 'Test results' && <p className="muted">{selected ? 'Code-evaluated gates for the selected candidate. Human approval is a separate decision.' : 'No selected candidate has verified test outcomes.'}</p>}
    {!rows.length && <p className="muted">{group === 'Observed' ? 'Awaiting the observed snapshot.' : group === 'Hypotheses' ? 'No ranked hypotheses yet.' : 'No additional evidence in this category.'}</p>}
    <ul className="facts-list">{rows.map((row) => <li key={row.id}>
      <div className="fact-heading"><code>{row.id}</code><span>{row.label}</span></div>
      <div><h4>{row.title}</h4><p>{row.detail}</p>
        {!!row.references.length && <details><summary>Sources: {row.references.join(', ')}</summary>
          <ul>{row.references.map((reference) => <li key={reference}><strong>{reference}</strong>: {sources.get(reference) ?? (reference === row.id ? row.detail : reference === selected?.change.id ? selected.change.label : 'See the candidate gate record.')}</li>)}</ul>
        </details>}
      </div>
    </li>)}</ul>
  </div>;
}

export function ImpactSummary({ frame, view, ready }: { frame: Frame; view: RunView | null; ready: boolean }) {
  const journeys = Object.values(frame.prod.probes);
  const affected = journeys.filter((p) => !p.ok);
  const selected = ready ? view?.run.selected : null;
  const original = view?.run.observation.probes.filter((p) => p.kind === 'journey' && !p.ok) ?? affected;
  const restored = selected?.fixed.filter((p) => p.kind === 'journey' && p.ok && original.some((o) => o.id === p.id)).length ?? 0;
  return (
    <section className="impact-summary" aria-label="Service impact">
      <div><span className="stage-kicker">Demo service impact</span><strong>{affected.length} of {journeys.length} journeys failing</strong>
        <span>{affected.length ? affected.map((p) => p.label).join(' · ') : frame.prod.status === 'restored' ? 'Recovery measured on the demo network' : 'All observed journeys reachable'}</span></div>
      <div><span className="stage-kicker">Tested recovery</span><strong>{selected ? `${restored} of ${original.length} affected journeys verified in twin` : 'Waiting for verified evidence'}</strong>
        <span>{selected ? `${selected.touched.length} device${selected.touched.length === 1 ? '' : 's'} changed · ${selected.challenges.length} challenges · rollback ${selected.rollback.matches ? 'rehearsed' : 'unverified'}` : 'A recommendation appears only after the defined checks.'}</span></div>
      {selected && restored < original.length && <p className="coverage-note">{original.length - restored} affected journeys are outside the tested slice. Recovery there is not established by this evidence.</p>}
    </section>
  );
}

function ChallengeCell({ candidate, kind }: { candidate: CandidateRecord; kind: string }) {
  const result = candidate.challenges.find((c) => c.kind === kind);
  return <td>{result ? <span title={result.detail}>{result.ok ? 'Pass' : result.soft ? 'Warning' : 'Fail'}</span> : <span className="muted">Not run</span>}</td>;
}

export function CandidateComparison({ view, onInspect }: { view: RunView; onInspect: (id: string) => void }) {
  return (
    <section className="comparison" aria-labelledby="comparison-title">
      <div className="section-caption"><h2 id="comparison-title">Why this fix?</h2><p>Compare the measured results. A missing test is shown as “Not run”.</p></div>
      <div className="table-wrap" role="region" aria-label="Candidate comparison" tabIndex={0}>
        <table className="diff comparison-table">
          <caption className="sr-only">Restoration, challenge coverage, policy and rollback for every candidate</caption>
          <thead><tr><th scope="col">Candidate</th><th scope="col">Journeys restored</th><th scope="col">IPv6</th><th scope="col">Warm cache</th><th scope="col">Secondary failure</th><th scope="col">Policy</th><th scope="col">Devices</th><th scope="col">Rollback</th><th scope="col">Decision</th></tr></thead>
          <tbody>{view.run.candidates.map((c) => (
            <tr key={c.change.id} className={c.change.id === view.run.selected?.change.id ? 'comparison-selected' : ''}>
              <th scope="row"><button type="button" className="evidence-link" onClick={() => onInspect(c.change.id)}>{c.change.label}</button>
                <small>{c.change.id === view.run.selected?.change.id ? 'Selected · ' : ''}{c.change.origin.replaceAll('_', ' ')}</small></th>
              <td>{c.restored ? 'Yes' : 'No'}</td><ChallengeCell candidate={c} kind="dual_stack" /><ChallengeCell candidate={c} kind="warm_cache" /><ChallengeCell candidate={c} kind="secondary_failure" />
              <td>{c.gates.find((g) => g.id === 'G5')?.status ?? 'Not run'}</td><td>{c.touched.length}</td><td>{c.rollback.matches ? 'Verified' : 'Unverified'}</td>
              <td><StatusChip tone={c.decision === 'pass' ? 'ok' : c.decision === 'pass_with_warnings' ? 'warn' : 'fail'}>{c.decision.replaceAll('_', ' ')}</StatusChip></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

export function EvidenceReplay({ events }: { events: RunEvent[] }) {
  const moments = events.filter((e) => ['fault_injected', 'reproduced', 'experiment_result', 'challenge_probe', 'revised', 'gate_verdict', 'post_check', 'rolled_back', 'recovery_required'].includes(e.kind));
  const [index, setIndex] = useState(0);
  const active = Math.min(index, moments.length - 1);
  const event = moments[active];
  if (!event) return null;
  const prod = Object.values(event.frame.prod.probes);
  const twin = Object.values(event.frame.twin?.probes ?? {});
  return (
    <details className="evidence-replay">
      <summary>Replay the evidence · {moments.length} recorded moments</summary>
      <p className="muted">Inspect what happened at each experiment and challenge. Replaying evidence does not apply a change.</p>
      <div className="replay-controls">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIndex(active - 1)} disabled={active === 0}>Previous</button>
        <label className="replay-slider">Recorded moment {active + 1} of {moments.length}<input type="range" min={0} max={moments.length - 1} value={active} onChange={(e) => setIndex(Number(e.target.value))} /></label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIndex(active + 1)} disabled={active === moments.length - 1}>Next</button>
      </div>
      <article aria-live="polite"><p className="stage-kicker">Recorded at {fmtClock(event.at)}</p><h3>{event.title}</h3><p>{event.summary}</p>
        <p className="replay-counts">Demo: {prod.filter((p) => !p.ok).length}/{prod.length} journeys failing · Twin: {twin.length ? `${twin.filter((p) => !p.ok).length}/${twin.length} failing` : 'not created'}</p>
      </article>
    </details>
  );
}
