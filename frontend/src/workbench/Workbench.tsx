import { Eye, EyeOff, FastForward, GitPullRequestArrow, RotateCcw, ShieldCheck, Siren, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import { FAULT_INFO, SUPPORTED_FAULTS } from '../engine/harness.ts';
import { decide, idleFrame, simulateDrift, startIncident, VERDICT_LABEL, type IncidentSession } from '../engine/orchestrator.ts';
import { PLANNER_MODE } from '../engine/planner.ts';
import { buildTopology, PACK_OPTIONS } from '../engine/topology.ts';
import type { FaultId, PackId, Phase, RunEvent } from '../engine/types.ts';
import { useReducedMotion } from '../lib/hooks.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import { Evidence } from './Evidence.tsx';
import { CandidateBoard, Counters, PhaseStepper, Stage, Timeline } from './panels.tsx';
import { fmtClock, usePlayback } from './usePlayback.ts';

const SPEEDS = [0.5, 1, 2, 4];
const ANNOUNCE = new Set(['fault_injected', 'reproduced', 'not_reproduced', 'gate_verdict', 'awaiting_approval', 'escalated', 'post_check', 'drift_detected', 'rolled_back', 'approval_rejected']);

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const fault = p.get('fault') as FaultId | null;
  return {
    speed: p.get('speed') === 'instant' ? Infinity : SPEEDS.includes(Number(p.get('speed'))) ? Number(p.get('speed')) : 1,
    fault: fault && fault in FAULT_INFO ? fault : 'random',
    autostart: p.get('autostart') === '1',
    pack: (p.get('pack') === 'enterprise' ? 'enterprise' : 'core') as PackId,
  } as const;
}

interface Props {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

interface Incident {
  session: IncidentSession;
  events: RunEvent[];
  sealed: FaultId;
}

function createIncident(pack: PackId, choice: 'random' | FaultId): Incident {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 100_000;
  const fault = choice === 'random' ? SUPPORTED_FAULTS[seed % SUPPORTED_FAULTS.length] : choice;
  const session = startIncident({ pack, fault, seed });
  return { session, events: session.run.events, sealed: fault };
}

export function Workbench({ theme, onToggleTheme }: Props) {
  const [params] = useState(readParams);
  const reduced = useReducedMotion();
  const [pack, setPack] = useState<PackId>(params.pack);
  const [faultChoice, setFaultChoice] = useState<'random' | FaultId>(params.fault);
  const [speed, setSpeed] = useState(params.speed);
  const [incident, setIncident] = useState<Incident | null>(() => (params.autostart ? createIncident(params.pack, params.fault) : null));
  const [reveal, setReveal] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [drifted, setDrifted] = useState(false);
  const topo = useMemo(() => buildTopology(pack), [pack]);
  const session = incident?.session ?? null;
  const events = useMemo(() => incident?.events ?? [], [incident]);
  const sealed = incident?.sealed ?? null;
  const { wall, marks, index, done, reset, skip } = usePlayback(events, speed);

  const visible = events.slice(0, index);
  const current = visible.at(-1);
  const frame = current?.frame ?? idleFrame(topo);
  const seen = new Set<Phase>(visible.map((e) => e.phase));
  const verdictEvent = visible.find((e) => e.kind === 'gate_verdict');
  const verdictVisible = Boolean(verdictEvent);
  const verdictWall = verdictEvent ? (marks[verdictEvent.seq] ?? wall) : null;
  const awaiting = visible.some((e) => e.kind === 'awaiting_approval') && !session?.outcome;
  const running = Boolean(session) && !done;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const breakNetwork = () => {
    reset();
    setIncident(createIncident(pack, faultChoice));
    setReveal(false);
    setInspectId(null);
    setDrifted(false);
  };

  const resetAll = () => {
    reset();
    setIncident(null);
    setInspectId(null);
  };

  const changePack = (next: PackId) => {
    setPack(next);
    resetAll();
  };

  const onDecide = (operator: string, comment: string, decision: 'approve' | 'reject') => {
    if (!incident) return;
    const post = decide(incident.session, operator, comment, decision);
    setDialogOpen(false);
    setIncident({ ...incident, events: [...incident.events, ...post] });
  };

  const onDrift = () => {
    if (!session) return;
    simulateDrift(session);
    setDrifted(true);
    setToast('Demo harness edited B17 after the snapshot. The pending approval will no longer match the target state.');
  };

  const announcement = current && ANNOUNCE.has(current.kind) ? `${current.title}. ${current.summary}` : '';
  const verdict = verdictVisible ? session?.run.verdict : undefined;
  const outcome = session?.outcome && visible.length === events.length ? session.outcome : undefined;

  return (
    <div className="wb">
      <SiteHeader variant="app" theme={theme} onToggleTheme={onToggleTheme} />
      <main id="main" className="wb-main" tabIndex={-1}>
        <section className="wb-hero">
          <div className="wb-title">
            <p className="eyebrow">Live workbench</p>
            <h1>
              Break it. <span className="grad-text">Watch TwinOps prove the fix.</span>
            </h1>
            <p className="mode-line">
              <StatusChip tone="info">Local model twin</StatusChip>
              <span>{PLANNER_MODE} · synthetic data only · no production access</span>
            </p>
          </div>

          <div className="wb-controls">
            <button type="button" className={`btn-break ${running ? 'is-running' : ''}`} onClick={breakNetwork} disabled={running}>
              <span className="btn-break-glow" aria-hidden="true" />
              <Zap size={22} aria-hidden="true" />
              <span>{running ? 'Investigating…' : session ? 'Break it again' : 'Break the network'}</span>
            </button>
            <div className="ctrl-row">
              <label className="field">
                <span>Fault</span>
                <select value={faultChoice} onChange={(e) => setFaultChoice(e.target.value as 'random' | FaultId)} disabled={running}>
                  <option value="random">Random · sealed</option>
                  {SUPPORTED_FAULTS.map((f) => (
                    <option key={f} value={f}>
                      {FAULT_INFO[f].code} · {FAULT_INFO[f].label}
                    </option>
                  ))}
                  <option value="unsupported_link_flap">F0 · Unsupported (control)</option>
                </select>
              </label>
              <label className="field">
                <span>Scenario pack</span>
                <select value={pack} onChange={(e) => changePack(e.target.value as PackId)} disabled={running}>
                  {PACK_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span id="speed-label">Pace</span>
                <div className="segmented" role="group" aria-labelledby="speed-label">
                  {SPEEDS.map((s) => (
                    <button key={s} type="button" aria-pressed={speed === s} className={speed === s ? 'is-on' : ''} onClick={() => setSpeed(s)}>
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              <div className="ctrl-buttons">
                <button type="button" className="btn btn-ghost btn-sm" onClick={skip} disabled={!running}>
                  <FastForward size={15} aria-hidden="true" /> Skip to review
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetAll} disabled={!session}>
                  <RotateCcw size={15} aria-hidden="true" /> Reset
                </button>
              </div>
            </div>
          </div>
        </section>

        <PhaseStepper seen={seen} current={frame.phase} />
        <Counters frame={frame} wall={wall} verdictAt={verdictVisible ? verdictWall : null} />

        <div className="wb-grid">
          <div className="wb-left">
            <Stage topo={topo} frame={frame} animate={!reduced} />
            <CandidateBoard frame={frame} onInspect={setInspectId} />
          </div>
          <aside className="wb-right" aria-label="Verdict and timeline">
            <section className={`verdict-card ${verdict ? `v-${verdict.toLowerCase()}` : session ? 'v-running' : 'v-idle'}`} aria-labelledby="verdict-title">
              {!session && (
                <>
                  <p className="stage-kicker">How to read this</p>
                  <h2 id="verdict-title">One button. Eight gates. Zero guesswork.</h2>
                  <p>The harness breaks the demo network with a fault TwinOps cannot see. TwinOps observes, reproduces the fault in a twin, tests fixes there, attacks its best answer and only then asks you.</p>
                </>
              )}
              {session && !verdict && (
                <>
                  <p className="stage-kicker">
                    Run {session.run.runId} · seed {session.run.seed}
                  </p>
                  <h2 id="verdict-title">Investigating — {frame.phase}</h2>
                  <div className="scan" aria-hidden="true" />
                  <p>Sealed fault: <span className="sealed">••••••••</span></p>
                </>
              )}
              {session && verdict && (
                <>
                  <p className="stage-kicker">
                    Verdict · {session.run.runId}
                  </p>
                  <h2 id="verdict-title" className="stamp">
                    {VERDICT_LABEL[verdict]}
                  </h2>
                  {session.run.selected ? (
                    <p className="verdict-change">
                      <GitPullRequestArrow size={16} aria-hidden="true" /> {session.run.selected.change.label}
                    </p>
                  ) : (
                    <p className="verdict-change">
                      <Siren size={16} aria-hidden="true" /> Escalated with evidence — no change proposed.
                    </p>
                  )}
                  {awaiting && session.run.selected && (
                    <div className="verdict-actions">
                      <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                        <ShieldCheck size={16} aria-hidden="true" /> Review &amp; approve
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={onDrift} disabled={drifted}>
                        <TriangleAlert size={15} aria-hidden="true" /> {drifted ? 'Drift injected' : 'Simulate drift'}
                      </button>
                    </div>
                  )}
                  {outcome && (
                    <p className="verdict-outcome">
                      <StatusChip tone={outcome.status === 'applied' ? 'ok' : outcome.status === 'rejected_by_operator' ? 'warn' : 'fail'}>
                        {outcome.status === 'applied' ? 'Applied · post-checks passed' : outcome.status === 'rejected_by_operator' ? 'Rejected by operator' : outcome.status === 'rolled_back' ? 'Rolled back' : 'Apply refused'}
                      </StatusChip>
                      <span>{outcome.reason}</span>
                    </p>
                  )}
                  <button type="button" className="reveal" onClick={() => setReveal((r) => !r)} aria-expanded={reveal}>
                    {reveal ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    {reveal && sealed ? (
                      <span>
                        Sealed fault: <strong>{FAULT_INFO[sealed].code} · {FAULT_INFO[sealed].label}</strong> — H1 was “{session.run.hypotheses[0].title}”
                      </span>
                    ) : (
                      <span>Reveal the sealed fault</span>
                    )}
                  </button>
                  <p className="verdict-meta">
                    Engine compute {session.run.computeMs} ms · paced for humans · time to verdict {fmtClock(verdictWall ?? wall)}
                  </p>
                </>
              )}
            </section>
            <Timeline events={visible} />
          </aside>
        </div>

        <Evidence session={session} frame={frame} inspectId={inspectId} onInspect={setInspectId} verdictVisible={verdictVisible} decisionVisible={Boolean(outcome)} />
      </main>

      {session?.run.selected && <ApprovalDialog open={dialogOpen} session={session} onClose={() => setDialogOpen(false)} onDecide={onDecide} />}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {toast && (
        <div className="toast" role="alert">
          <TriangleAlert size={16} aria-hidden="true" /> {toast}
        </div>
      )}
    </div>
  );
}
