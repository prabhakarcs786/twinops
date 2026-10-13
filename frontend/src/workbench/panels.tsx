import { Activity, Bot, Braces, CircleDashed, FlaskConical, Gavel, Radar, ShieldAlert, Swords, UserCheck, Wrench } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';
import { TopologyCanvas } from '../components/TopologyCanvas.tsx';
import type { Actor, CandidateSummary, Frame, Phase, RunEvent, Topology } from '../engine/types.ts';
import { fmtClock } from './usePlayback.ts';
import { DEMO_TARGET, type TargetCopy } from './runView.ts';

const PHASES: { id: Phase; label: string }[] = [
  { id: 'observe', label: 'Observe' },
  { id: 'diagnose', label: 'Diagnose' },
  { id: 'reproduce', label: 'Reproduce' },
  { id: 'experiment', label: 'Experiment' },
  { id: 'challenge', label: 'Challenge' },
  { id: 'gate', label: 'Proof Gate' },
  { id: 'approve', label: 'Human approval' },
  { id: 'apply', label: 'Apply (lab)' },
];

export function PhaseStepper({ seen, current, escalated = false }: { seen: Set<Phase>; current: Phase; escalated?: boolean }) {
  return (
    <ol className="stepper" aria-label="Incident pipeline">
      {PHASES.map((p, i) => {
        const state = p.id === current ? 'active' : seen.has(p.id) ? 'done' : 'todo';
        return (
          <li key={p.id} className={`step is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="step-dot">{i + 1}</span>
            <span className="step-label">{escalated && p.id === 'approve' ? 'Escalated to on-call' : p.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Counters({ frame, wall, verdictAt, target = DEMO_TARGET }: { frame: Frame; wall: number; verdictAt: number | null; target?: TargetCopy }) {
  const c = frame.counters;
  const items: { label: string; value: ReactNode; hint: string; tone?: string }[] = [
    { label: verdictAt !== null ? 'Time to verdict' : 'Elapsed', value: fmtClock(verdictAt ?? wall), hint: 'real time since the break' },
    { label: 'Experiments in twin', value: c.experiments, hint: `${c.revisions} revised after a challenge` },
    { label: 'Challenges run', value: c.challengesRun, hint: `${c.probesRun} probes executed` },
    { label: 'Unsafe fixes rejected', value: c.unsafeRejected, hint: 'failed regression, challenge or policy', tone: c.unsafeRejected ? 'fail' : undefined },
    { label: 'Production writes during diagnosis', value: c.productionWritesDuringDiagnosis, hint: `computed from the ${target.prose.replace(/^the /, '')} write log`, tone: 'ok' },
  ];
  return (
    <dl className="counters">
      {items.map((item) => (
        <div key={item.label} className={`counter ${item.tone ? `counter-${item.tone}` : ''}`}>
          <dt>{item.label}</dt>
          <dd>
            <span className="counter-value">{item.value}</span>
            <span className="counter-hint">{item.hint}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function JourneyList({ probes }: { probes: Frame['prod']['probes'] }) {
  const list = Object.values(probes);
  if (!list.length) return null;
  return (
    <ul className="journeys">
      {list.map((p) => (
        <li key={p.id}>
          <StatusChip tone={p.ok ? 'ok' : 'fail'}>{p.id}</StatusChip>
          <span className="journey-label">{p.label}</span>
          <span className="journey-detail">{p.ok ? `${p.latencyMs} ms` : p.failure?.replace('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

const TWIN_STATE: Record<NonNullable<Frame['twin']>['state'], { tone: ChipTone; text: string }> = {
  building: { tone: 'pending', text: 'Building' },
  reproduced: { tone: 'ok', text: 'Fault reproduced' },
  not_reproduced: { tone: 'fail', text: 'Not reproduced' },
  experiment: { tone: 'twin', text: 'Experimenting' },
  challenge: { tone: 'warn', text: 'Under challenge' },
  idle: { tone: 'info', text: 'Evidence recorded' },
};

export function Stage({ topo, frame, animate, target = DEMO_TARGET }: { topo: Topology; frame: Frame; animate: boolean; target?: TargetCopy }) {
  const prodTone: ChipTone = frame.prod.status === 'healthy' ? 'ok' : frame.prod.status === 'restored' ? 'ok' : 'fail';
  const prodText = frame.prod.status === 'healthy' ? 'Healthy' : frame.prod.status === 'restored' ? 'Restored · verified' : 'Incident';
  return (
    <div className="stage">
      <section className={`stage-panel stage-prod is-${frame.prod.status}`} aria-labelledby="prod-title">
        <header>
          <div>
            <p className="stage-kicker">{target.kicker}</p>
            <h2 id="prod-title">{target.name}</h2>
          </div>
          <StatusChip tone={prodTone}>{prodText}</StatusChip>
        </header>
        <p className="stage-note">{target.note}</p>
        <TopologyCanvas topo={topo} variant="prod" probes={frame.prod.probes} alarmNodes={frame.prod.alarmNodes} animate={animate} label={`${target.name}: ${prodText}`} />
        <JourneyList probes={frame.prod.probes} />
      </section>

      <section className={`stage-panel stage-twin ${frame.twin ? 'is-live' : 'is-empty'}`} aria-labelledby="twin-title">
        <header>
          <div>
            <p className="stage-kicker">Isolated digital twin</p>
            <h2 id="twin-title">Affected slice</h2>
          </div>
          {frame.twin ? <StatusChip tone={TWIN_STATE[frame.twin.state].tone}>{TWIN_STATE[frame.twin.state].text}</StatusChip> : <StatusChip tone="skip">Not created</StatusChip>}
        </header>
        <p className="stage-note">{frame.twin ? frame.twin.caption : 'Created from the captured snapshot after the network breaks.'}</p>
        {frame.twin ? (
          <>
            <TopologyCanvas
              topo={topo}
              variant="twin"
              probes={frame.twin.probes}
              slice={frame.twin.slice}
              focus={frame.twin.focus}
              failedNodes={frame.twin.failedNodes}
              animate={animate}
              label={`Twin slice of ${frame.twin.slice.length} nodes: ${frame.twin.caption}`}
            />
            <JourneyList probes={frame.twin.probes} />
          </>
        ) : (
          <div className="twin-empty">
            <CircleDashed size={42} strokeWidth={1.2} aria-hidden="true" />
            <p>No twin yet. TwinOps never experiments on {target.prose} itself.</p>
          </div>
        )}
      </section>
    </div>
  );
}

const CANDIDATE_TONE: Record<CandidateSummary['status'], { tone: ChipTone; text: string }> = {
  testing: { tone: 'twin', text: 'Testing' },
  challenging: { tone: 'warn', text: 'Under challenge' },
  pass: { tone: 'ok', text: 'Pass' },
  warn: { tone: 'warn', text: 'Pass w/ warnings' },
  rejected: { tone: 'fail', text: 'Rejected' },
  superseded: { tone: 'skip', text: 'Superseded' },
};

export function CandidateBoard({ frame, onInspect }: { frame: Frame; onInspect: (id: string) => void }) {
  if (!frame.candidates.length) {
    return (
      <div className="board board-empty">
        <FlaskConical size={18} aria-hidden="true" />
        <span>Candidate fixes appear here once the fault is reproduced. Each runs on a fresh copy of the same faulty state.</span>
      </div>
    );
  }
  return (
    <ul className="board" aria-label="Candidate fixes">
      {frame.candidates.map((c) => {
        const tone = CANDIDATE_TONE[c.status];
        const [letter, ...rest] = c.label.split(' · ');
        return (
          <li key={c.id} className={`cand cand-${c.status} ${frame.selectedId === c.id ? 'is-selected' : ''}`}>
            <button type="button" onClick={() => onInspect(c.id)} aria-label={`Inspect evidence for ${c.label}`}>
              <span className="cand-letter">{letter}</span>
              <span className="cand-body">
                <span className="cand-title">{rest.join(' · ')}</span>
                <span className="cand-note">{c.note}</span>
              </span>
              <span className="cand-meta">
                <StatusChip tone={tone.tone}>{tone.text}</StatusChip>
                {c.origin !== 'runbook' && <span className={`origin origin-${c.origin}`}>{c.origin === 'revision' ? 'revision' : c.origin === 'llm' ? 'model-proposed' : c.origin === 'memory' ? 'historical fix' : 'evaluation case'}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const ACTOR_ICON: Record<Actor, typeof Activity> = {
  harness: ShieldAlert,
  observer: Radar,
  guard: ShieldAlert,
  diagnosis: Bot,
  twin: CircleDashed,
  experiment: FlaskConical,
  challenge: Swords,
  gate: Gavel,
  operator: UserCheck,
  apply: Wrench,
};

const ACTOR_LABEL: Record<Actor, string> = {
  harness: 'Demo harness',
  observer: 'Observation',
  guard: 'Input guard',
  diagnosis: 'Diagnosis role',
  twin: 'Twin manager',
  experiment: 'Experiment runner',
  challenge: 'Challenge role',
  gate: 'Proof Gate',
  operator: 'Human',
  apply: 'Apply gateway',
};

export function Timeline({ events }: { events: RunEvent[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [events.length]);
  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <header>
        <h2 id="timeline-title">
          <Activity size={16} aria-hidden="true" /> Run timeline
        </h2>
        <span className="timeline-count">{events.length} events</span>
      </header>
      {events.length === 0 ? (
        <p className="timeline-empty">Press <strong>Break the network</strong>. A hidden fault is injected by the demo harness; TwinOps only sees what an operator would see.</p>
      ) : (
        <ol ref={listRef} className="timeline-list">
          {events.map((e) => {
            const Icon = ACTOR_ICON[e.actor];
            return (
              <li key={e.seq} className={`tl tl-${e.tone}`}>
                <span className="tl-icon" aria-hidden="true">
                  <Icon size={14} />
                </span>
                <div className="tl-body">
                  <p className="tl-meta">
                    <span>{fmtClock(e.at)}</span>
                    <span>{ACTOR_LABEL[e.actor]}</span>
                  </p>
                  <p className="tl-title">{e.title}</p>
                  <p className="tl-summary">{e.summary}</p>
                  <details>
                    <summary>
                      <Braces size={12} aria-hidden="true" /> Raw evidence
                    </summary>
                    <pre>{JSON.stringify(e.raw, null, 2)}</pre>
                  </details>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
