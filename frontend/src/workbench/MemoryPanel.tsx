import { ArrowRight, ExternalLink, History, RefreshCw } from 'lucide-react';
import { StatusChip } from '../components/StatusChip.tsx';
import { describeStep } from '../engine/catalogue.ts';
import type { RunResult } from '../engine/orchestrator.ts';
import { shortHash } from '../engine/sha256.ts';
import type { Frame, MemoryMatch, RunEvent } from '../engine/types.ts';

interface Props {
  run: RunResult | null;
  events: RunEvent[];
  frame: Frame;
  onInspect: (id: string) => void;
}

export function MemoryPanel({ run, events, frame, onInspect }: Props) {
  const recalled = events.find((event) => event.kind === 'memory_recalled');
  const matches = run?.memory ?? (recalled?.raw as { matches?: MemoryMatch[] } | undefined)?.matches ?? [];
  if (!matches.length) {
    return <div className="memory-empty">
      <History size={24} aria-hidden="true" />
      <h3>{recalled ? 'No proven match yet' : 'No historical evidence attached'}</h3>
      <p className="muted">{recalled ? 'No compatible, successfully applied fix matches the observed failure signals.' : 'Historical fixes require a live backend and a saved, successfully applied incident.'}</p>
    </div>;
  }
  return <div className="memory-panel">
    {matches.map((match) => {
      const tested = run?.candidates.find((candidate) => candidate.change.id === match.candidate.id);
      const progress = frame.candidates.find((candidate) => candidate.id === match.candidate.id);
      const passed = tested?.decision === 'pass' || tested?.decision === 'pass_with_warnings';
      const revision = run?.candidates.find((candidate) => candidate.change.parentId === match.candidate.id);
      return <article key={match.sourceRunId} className="memory-match" aria-label="Historical fix retest">
        <header className="memory-heading">
          <History size={20} aria-hidden="true" />
          <div><h3>A previous fix, a fresh decision</h3><p>{match.matchedSignals.length}/{match.signalCount} observed failure signals match</p></div>
          <StatusChip tone={match.sameSnapshot ? 'info' : 'warn'}>{match.sameSnapshot ? 'Same captured state' : 'Target state has changed'}</StatusChip>
        </header>
        <div className="memory-columns">
          <section aria-label="Previous evidence">
            <p className="stage-kicker">Previously applied</p>
            <h4>{match.sourceLabel}</h4>
            <a className="memory-source" href={`/workbench?incident=${encodeURIComponent(match.sourceRunId)}`} target="_blank" rel="noreferrer">
              {match.sourceRunId} <ExternalLink size={14} aria-label="opens in a new tab" />
            </a>
            <p className="muted">{new Date(match.sourceCreatedAt * 1000).toLocaleString()} · {match.sourceBackend} twin</p>
            <ul className="memory-signals">{match.matchedSignals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
            <p className="memory-hash">Previous change <code>{shortHash(match.sourceChangeHash)}</code></p>
          </section>
          <section aria-label="Fresh verification">
            <p className="stage-kicker">Current investigation</p>
            <h4><RefreshCw size={16} aria-hidden="true" /> {tested ? passed ? 'Passed fresh tests' : revision ? 'Past fix needed revision' : 'Past fix rejected' : progress ? 'Retest in progress' : 'Awaiting twin tests'}</h4>
            <ul className="memory-steps">{match.candidate.steps.map((step) => <li key={describeStep(step)}><code>{describeStep(step)}</code></li>)}</ul>
            <p className="memory-hash">New candidate <code>{shortHash(match.candidate.hash)}</code></p>
            <p className="muted">Historical approval not reused. Current tests, rollback and human approval are required.</p>
            {tested && <>
              <StatusChip tone={passed ? 'ok' : revision ? 'warn' : 'fail'}>{passed ? 'Verified under current tests' : 'Historical success is not current proof'}</StatusChip>
              {tested.reasons.length > 0 && <p className="memory-reason">{tested.reasons.join(' ')}</p>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onInspect(tested.change.id)}>Inspect fresh gates <ArrowRight size={14} aria-hidden="true" /></button>
            </>}
          </section>
        </div>
      </article>;
    })}
  </div>;
}