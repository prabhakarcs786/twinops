import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';
import { VERDICT_LABEL } from '../engine/orchestrator.ts';
import { shortHash } from '../engine/sha256.ts';
import type { GateStatus } from '../engine/types.ts';
import { demoRun, letterOf, nameOf } from './demoRun.ts';

const GATE_TONE: Record<GateStatus, ChipTone> = { pass: 'ok', fail: 'fail', warn: 'warn', skip: 'skip', pending: 'pending' };

function ObserveVisual() {
  const run = demoRun();
  const flagged = run.guardedLogs.find((l) => l.flagged);
  return (
    <div className="viz viz-feed">
      <p className="viz-head">
        <span>Read-only snapshot</span>
        <code>{shortHash(run.snapshotHash)}</code>
      </p>
      <ul>
        {run.observation.alarms.slice(0, 5).map((a) => (
          <li key={a.id} className={`sev-${a.severity}`}>
            <span className="feed-node">{a.node}</span>
            <span className="feed-sev">{a.severity}</span>
            <span className="feed-text">{a.text}</span>
            {!a.modelled && <span className="feed-tag">outside twin fidelity</span>}
          </li>
        ))}
        {flagged && (
          <li className="is-quarantined">
            <span className="feed-node">{flagged.node}</span>
            <span className="feed-sev">log</span>
            <span className="feed-text">{flagged.text}</span>
            <span className="feed-tag">quarantined · data only</span>
          </li>
        )}
      </ul>
      <p className="viz-foot">
        {run.observation.rawEventCount} raw events → {run.observation.alarms.length} alarms · {run.observation.changes.length} change records
      </p>
    </div>
  );
}

function DiagnoseVisual() {
  const run = demoRun();
  const max = Math.max(...run.hypotheses.map((h) => h.score), 1);
  return (
    <div className="viz viz-hyps">
      {run.hypotheses.map((h) => (
        <div key={h.id} className="hyp-bar">
          <p>
            <strong>H{h.rank}</strong> {h.title}
          </p>
          <span className="bar">
            <span style={{ width: `${Math.max(6, (Math.max(h.score, 0) / max) * 100)}%` }} />
          </span>
          <p className="hyp-counts">
            {h.supporting.length} supporting · {h.contradicting.length} contradicting
          </p>
        </div>
      ))}
      <p className="viz-foot">Evidence counts, not invented confidence percentages.</p>
    </div>
  );
}

function ReproduceVisual() {
  const run = demoRun();
  const rows = run.observation.probes.slice(0, 7).map((p) => ({ prod: p, twin: run.reproduction.twinProbes.find((t) => t.id === p.id) }));
  return (
    <div className="viz viz-repro">
      <div className="repro-grid">
        <span className="repro-h">Symptom</span>
        <span className="repro-h">Production</span>
        <span className="repro-h">Twin</span>
        {rows.map(({ prod, twin }) => (
          <div key={prod.id} className="repro-row">
            <span>{prod.id}</span>
            <StatusChip tone={prod.ok ? 'ok' : 'fail'}>{prod.ok ? 'ok' : prod.failure?.replace('_', ' ')}</StatusChip>
            {twin ? <StatusChip tone={twin.ok ? 'ok' : 'fail'}>{twin.ok ? 'ok' : twin.failure?.replace('_', ' ')}</StatusChip> : <StatusChip tone="skip">outside slice</StatusChip>}
          </div>
        ))}
      </div>
      <p className="viz-big">
        {run.reproduction.matched}/{run.reproduction.total} <span>symptoms reproduced · slice of {run.reproduction.slice.length} nodes</span>
      </p>
    </div>
  );
}

function ExperimentVisual() {
  const run = demoRun();
  return (
    <ul className="viz viz-cands">
      {run.candidates
        .filter((c) => c.change.origin !== 'revision')
        .map((c) => (
          <li key={c.change.id}>
            <span className="cand-letter">{letterOf(c.change.label)}</span>
            <span className="cand-name">{nameOf(c.change.label)}</span>
            <StatusChip tone={c.restored ? 'ok' : 'fail'}>{c.restored ? 'restores' : 'no effect'}</StatusChip>
            {c.latencyDeltaMs > 0 && <span className="cand-delta">+{c.latencyDeltaMs} ms</span>}
          </li>
        ))}
      <li className="viz-foot">Each on a fresh copy of the same faulty state.</li>
    </ul>
  );
}

function ChallengeVisual() {
  const run = demoRun();
  const parent = run.candidates.find((c) => c.decision === 'superseded');
  const child = run.candidates.find((c) => c.change.parentId === parent?.change.id);
  return (
    <div className="viz viz-challenge">
      {[parent, child].filter(Boolean).map((c) => (
        <div key={c!.change.id} className="challenge-block">
          <p className="challenge-title">
            <span className="cand-letter">{letterOf(c!.change.label)}</span> {nameOf(c!.change.label)}
          </p>
          <ul>
            {c!.challenges.map((ch) => (
              <li key={ch.id}>
                <StatusChip tone={ch.ok ? 'ok' : ch.soft ? 'warn' : 'fail'}>{ch.label}</StatusChip>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {child && <p className="viz-foot">{child.change.rationale}</p>}
    </div>
  );
}

function ProveVisual() {
  const run = demoRun();
  const selected = run.selected!;
  return (
    <div className="viz viz-gates">
      {selected.gates.map((g) => (
        <div key={g.id} className={`gate-tile g-${g.status}`}>
          <span className="gate-tile-id">{g.id}</span>
          <StatusChip tone={GATE_TONE[g.status]}>{g.status}</StatusChip>
        </div>
      ))}
      <p className="viz-big">
        {VERDICT_LABEL[run.verdict]} <span>{selected.change.label}</span>
      </p>
    </div>
  );
}

function ApproveVisual() {
  const run = demoRun();
  return (
    <div className="viz viz-approve">
      <p className="viz-head">
        <span>Human gate · G8</span>
        <span>demo lab only</span>
      </p>
      <p className="approve-change">{run.selected?.change.label}</p>
      <dl>
        <div>
          <dt>Change hash</dt>
          <dd>
            <code>{shortHash(run.selected!.change.hash)}</code>
          </dd>
        </div>
        <div>
          <dt>Target state</dt>
          <dd>
            <code>{shortHash(run.snapshotHash)}</code>
          </dd>
        </div>
      </dl>
      <span className="fake-btn">Approve &amp; apply to demo lab</span>
      <p className="viz-big">
        {run.writesDuringDiagnosis} <span>production writes during diagnosis — computed from the write log</span>
      </p>
    </div>
  );
}

const STEPS: { kicker: string; title: string; body: string; visual: ReactNode }[] = [
  {
    kicker: 'Observe',
    title: 'A read-only, hashed snapshot',
    body: 'Topology, probes, alarms, configuration history and logs are captured into a versioned snapshot. Log text is untrusted data: instruction-like lines are quarantined, never obeyed.',
    visual: <ObserveVisual />,
  },
  {
    kicker: 'Diagnose',
    title: 'Ranked hypotheses, not one guess',
    body: 'Root-cause hypotheses are scored from supporting and contradicting evidence. The fault label is sealed — TwinOps sees only what an operator would see.',
    visual: <DiagnoseVisual />,
  },
  {
    kicker: 'Reproduce',
    title: 'A twin of only the affected slice',
    body: 'The twin is built from captured state. If symptoms do not match, TwinOps stops: NOT REPRODUCED is a valid answer, a guessed fix is not.',
    visual: <ReproduceVisual />,
  },
  {
    kicker: 'Experiment',
    title: 'Competing fixes on fresh copies',
    body: 'Each candidate is a typed, allow-listed action — never a shell command — applied to a reset copy of the same faulty state, with a rehearsed rollback.',
    visual: <ExperimentVisual />,
  },
  {
    kicker: 'Challenge',
    title: 'Attack the best answer',
    body: 'A challenge role chooses adverse conditions from an approved catalogue — IPv6 parity, secondary failure, ×3 surge, warm caches, session continuity — and forces a revision when it finds a weakness.',
    visual: <ChallengeVisual />,
  },
  {
    kicker: 'Prove',
    title: 'A deterministic Proof Gate',
    body: 'Eight gates decide with reasons. The model cannot edit tests, skip a check or approve its own output. Missing results are failures, not passes.',
    visual: <ProveVisual />,
  },
  {
    kicker: 'Approve & apply',
    title: 'A human signs the exact change',
    body: 'Approval binds to the change hash, the run and the target state. Drift invalidates it. Post-change checks run; a failure triggers the rehearsed rollback.',
    visual: <ApproveVisual />,
  },
];

export function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section id="how" className="section story" aria-labelledby="how-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">02 — How it works</p>
          <h2 id="how-title">
            Observe → reproduce → experiment → challenge → <span className="grad-text">prove</span> → approve.
          </h2>
          <p className="lead">Every number below comes from a real seeded run computed in your browser — not a mock-up.</p>
        </header>

        <div className="story-grid">
          <div className="story-sticky">
            <div className="story-visual">
              <div className="story-rail" aria-hidden="true">
                {STEPS.map((s, i) => (
                  <span key={s.kicker} className={i <= active ? 'is-on' : ''} />
                ))}
              </div>
              <p className="story-count" aria-hidden="true">
                <span>{String(active + 1).padStart(2, '0')}</span> / {String(STEPS.length).padStart(2, '0')} · {STEPS[active].kicker}
              </p>
              <div className="story-stack">
                {STEPS.map((s, i) => (
                  <div key={s.kicker} className={`story-panel ${i === active ? 'is-active' : ''}`} aria-hidden={i !== active}>
                    {s.visual}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <ol className="story-steps">
            {STEPS.map((s, i) => (
              <li
                key={s.kicker}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                data-index={i}
                className={i === active ? 'is-active' : ''}
              >
                <p className="step-kicker">
                  <span>{String(i + 1).padStart(2, '0')}</span> {s.kicker}
                </p>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <div className="step-visual-inline">{s.visual}</div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
