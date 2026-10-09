import { Bot, Eye, EyeOff, FastForward, GitPullRequestArrow, MessageSquareText, RotateCcw, ShieldCheck, Siren, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { createIncident as createLiveIncident, fetchConfig, getIncident, getReveal, postDecision, postDrift, subscribe, type BackendConfig, type LiveIncident } from '../api/live.ts';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import { FAULT_INFO, SUPPORTED_FAULTS } from '../engine/harness.ts';
import { decide, idleFrame, simulateDrift, startIncident, VERDICT_LABEL, type IncidentSession } from '../engine/orchestrator.ts';
import { PLANNER_MODE } from '../engine/planner.ts';
import { buildTopology, PACK_OPTIONS } from '../engine/topology.ts';
import type { FaultId, PackId, Phase, RunEvent } from '../engine/types.ts';
import { useReducedMotion } from '../lib/hooks.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import { ModelThinking } from './AiTrace.tsx';
import { Evidence, type AskTarget, type EvidenceTab } from './Evidence.tsx';
import { CandidateBoard, Counters, PhaseStepper, Stage, Timeline } from './panels.tsx';
import { liveView, localView, type RunView } from './runView.ts';
import { fmtClock, usePlayback } from './usePlayback.ts';

const SPEEDS = [0.5, 1, 2, 4];
const ANNOUNCE = new Set(['fault_injected', 'model_call', 'reproduced', 'not_reproduced', 'gate_verdict', 'awaiting_approval', 'escalated', 'post_check', 'drift_detected', 'rolled_back', 'approval_rejected', 'run_failed']);
const OUTCOME_KINDS = new Set(['post_check', 'rolled_back', 'drift_detected', 'approval_rejected']);

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const fault = p.get('fault') as FaultId | null;
  return {
    speed: p.get('speed') === 'instant' ? Infinity : SPEEDS.includes(Number(p.get('speed'))) ? Number(p.get('speed')) : 1,
    fault: fault && fault in FAULT_INFO ? fault : 'random',
    autostart: p.get('autostart') === '1',
    pack: (p.get('pack') === 'enterprise' ? 'enterprise' : 'core') as PackId,
    engine: p.get('engine') === 'local' ? 'local' : 'live',
  } as const;
}

interface Props {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

/** A run computed entirely in the browser (synthetic model twin). */
interface LocalIncident {
  kind: 'local';
  session: IncidentSession;
  events: RunEvent[];
  sealed: FaultId;
}

/** A run executing on the backend; events stream in over SSE as the work happens. */
interface LiveRun {
  kind: 'live';
  id: string;
  eventsUrl: string;
  seed: number;
  events: RunEvent[];
  detail: LiveIncident | null;
  ended: boolean;
}

type Incident = LocalIncident | LiveRun;

function createLocalIncident(pack: PackId, choice: 'random' | FaultId): LocalIncident {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 100_000;
  const fault = choice === 'random' ? SUPPORTED_FAULTS[seed % SUPPORTED_FAULTS.length] : choice;
  const session = startIncident({ pack, fault, seed });
  return { kind: 'local', session, events: session.run.events, sealed: fault };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function Workbench({ theme, onToggleTheme }: Props) {
  const [params] = useState(readParams);
  const reduced = useReducedMotion();
  const [pack, setPack] = useState<PackId>(params.pack);
  const [faultChoice, setFaultChoice] = useState<'random' | FaultId>(params.fault);
  const [speed, setSpeed] = useState(params.speed);
  const [backend, setBackend] = useState<BackendConfig | null | undefined>(params.engine === 'local' ? null : undefined);
  const [enginePref, setEnginePref] = useState<'live' | 'local'>(params.engine);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [starting, setStarting] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [revealed, setRevealed] = useState<{ code: string; label: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>('hypotheses');
  const [drifted, setDrifted] = useState(false);
  const topo = useMemo(() => buildTopology(pack), [pack]);
  const engine: 'live' | 'local' = backend && enginePref === 'live' ? 'live' : 'local';

  const local = incident?.kind === 'local' ? incident : null;
  const live = incident?.kind === 'live' ? incident : null;
  const session = local?.session ?? null;
  const events = useMemo(() => incident?.events ?? [], [incident]);
  const playback = usePlayback(local ? events : [], speed);
  const { reset, skip } = playback;

  const index = live ? events.length : playback.index;
  const visible = live ? events : events.slice(0, index);
  const current = visible.at(-1);
  const frame = current?.frame ?? idleFrame(topo);
  const seen = new Set<Phase>(visible.map((e) => e.phase));
  const verdictEvent = visible.find((e) => e.kind === 'gate_verdict');
  const failedEvent = live ? visible.find((e) => e.kind === 'run_failed') : undefined;
  const wall = live ? (current?.at ?? 0) : playback.wall;
  const verdictWall = verdictEvent ? (live ? verdictEvent.at : (playback.marks[verdictEvent.seq] ?? wall)) : null;

  const view: RunView | null = local
    ? localView(local.session)
    : live?.detail?.run
      ? liveView(live.id, live.detail.run, live.detail.outcome, live.detail.approval, visible.some((e) => e.kind === 'narrative') ? live.detail.narrative : null)
      : null;
  const verdictVisible = Boolean(verdictEvent) && Boolean(view);
  const liveOutcomeVisible = Boolean(live?.ended) || (current ? OUTCOME_KINDS.has(current.kind) : false);
  const outcome = local ? (session?.outcome && playback.done ? session.outcome : undefined) : liveOutcomeVisible ? (live?.detail?.outcome ?? undefined) : undefined;
  const decided = visible.some((e) => e.kind === 'approval_recorded' || e.kind === 'applied' || OUTCOME_KINDS.has(e.kind));
  const awaiting = visible.some((e) => e.kind === 'awaiting_approval') && !decided && !view?.outcome && !outcome;
  const running = local ? !playback.done : live ? !verdictEvent && !failedEvent && !live.ended : starting;
  const hasRun = Boolean(incident);

  // Probe for a backend once; without one the workbench runs the in-browser engine.
  useEffect(() => {
    if (backend !== undefined) return;
    let alive = true;
    void fetchConfig().then((cfg) => {
      if (alive) setBackend(cfg);
    });
    return () => {
      alive = false;
    };
  }, [backend]);

  const liveId = live?.id ?? null;
  const liveUrl = live?.eventsUrl ?? null;
  useEffect(() => {
    if (!liveId || !liveUrl) return;
    return subscribe(
      liveUrl,
      (e) => setIncident((cur) => (cur?.kind === 'live' && cur.id === liveId && !cur.events.some((x) => x.seq === e.seq) ? { ...cur, events: [...cur.events, e] } : cur)),
      () => setIncident((cur) => (cur?.kind === 'live' && cur.id === liveId ? { ...cur, ended: true } : cur)),
      () => setToast('Lost the event stream from the backend.'),
    );
  }, [liveId, liveUrl]);

  // After the verdict, refresh the authoritative run record whenever new events arrive.
  const needDetail = Boolean(live && (verdictEvent || failedEvent));
  const liveCount = live?.events.length ?? 0;
  const liveEnded = live?.ended ?? false;
  useEffect(() => {
    if (!liveId || !needDetail) return;
    let alive = true;
    getIncident(liveId)
      .then((detail) => {
        if (alive) setIncident((cur) => (cur?.kind === 'live' && cur.id === liveId ? { ...cur, detail } : cur));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [liveId, needDetail, liveCount, liveEnded]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const clearRunState = () => {
    reset();
    setReveal(false);
    setRevealed(null);
    setInspectId(null);
    setDrifted(false);
    setDecisionError(null);
  };

  const breakNetwork = async () => {
    clearRunState();
    if (engine === 'local') {
      setIncident(createLocalIncident(pack, faultChoice));
      return;
    }
    setIncident(null);
    setStarting(true);
    try {
      const created = await createLiveIncident({ pack, fault: faultChoice, pace: Number.isFinite(speed) ? speed : 0 });
      setIncident({ kind: 'live', id: created.incidentId, eventsUrl: created.eventsUrl, seed: created.seed, events: [], detail: null, ended: false });
    } catch (err) {
      setToast(`Backend did not start the run — ${errorText(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const onAutostart = useEffectEvent(() => {
    void breakNetwork();
  });
  useEffect(() => {
    if (!params.autostart || backend === undefined) return;
    const t = window.setTimeout(() => onAutostart(), 0);
    return () => window.clearTimeout(t);
  }, [params.autostart, backend]);

  const resetAll = () => {
    clearRunState();
    setIncident(null);
  };

  const changePack = (next: PackId) => {
    setPack(next);
    resetAll();
  };

  const changeEngine = (next: 'live' | 'local') => {
    setEnginePref(next);
    resetAll();
  };

  const onDecide = async (operator: string, comment: string, decision: 'approve' | 'reject', passcode: string) => {
    if (!incident) return;
    if (incident.kind === 'local') {
      const post = decide(incident.session, operator, comment, decision);
      setDialogOpen(false);
      setIncident({ ...incident, events: [...incident.events, ...post] });
      return;
    }
    setDecisionBusy(true);
    setDecisionError(null);
    // Auth and state errors return immediately; a lab apply can take a while, so the dialog closes and the stream shows progress.
    const request = postDecision(incident.id, { decision, operator, comment }, passcode || undefined);
    const early = await Promise.race([
      request.then(
        () => 'done' as const,
        (err: unknown) => new Error(errorText(err)),
      ),
      new Promise<'pending'>((resolve) => window.setTimeout(() => resolve('pending'), 1200)),
    ]);
    setDecisionBusy(false);
    if (early instanceof Error) {
      setDecisionError(early.message);
      return;
    }
    setDialogOpen(false);
    if (early === 'pending') request.catch((err: unknown) => setToast(errorText(err)));
  };

  const onDrift = async () => {
    if (local) {
      simulateDrift(local.session);
    } else if (live) {
      try {
        await postDrift(live.id);
      } catch (err) {
        setToast(errorText(err));
        return;
      }
    }
    setDrifted(true);
    setToast('Demo harness edited B17 after the snapshot. The pending approval will no longer match the target state.');
  };

  const onReveal = async () => {
    if (live && !revealed && !reveal) {
      try {
        const r = await getReveal(live.id);
        setRevealed({ code: r.code, label: r.label });
      } catch (err) {
        setToast(errorText(err));
        return;
      }
    }
    setReveal((r) => !r);
  };

  const sealedLabel = local ? `${FAULT_INFO[local.sealed].code} · ${FAULT_INFO[local.sealed].label}` : revealed ? `${revealed.code} · ${revealed.label}` : null;
  const announcement = current && ANNOUNCE.has(current.kind) ? `${current.title}. ${current.summary}` : '';
  const verdict = verdictVisible ? view?.run.verdict : undefined;
  const runId = view?.run.runId ?? live?.id ?? session?.run.runId ?? '';
  const seed = live?.seed ?? session?.run.seed;
  const twinLabel = backend?.twin.backend === 'emulated' ? 'Containerlab emulated twin' : 'model twin';
  const canDrift = engine === 'local' || Boolean(backend?.harness && !backend.approvalAuth);
  const thinking = current?.kind === 'model_call' ? current : undefined;
  const ask: AskTarget | null = live && backend?.planner.kind === 'llm' ? { incidentId: live.id, model: backend.planner.model, ready: Boolean(view) } : null;
  const openAsk = () => {
    setEvidenceTab('ask');
    window.setTimeout(() => document.getElementById('ask-input')?.focus(), 50);
  };

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
              {engine === 'live' && backend ? (
                <>
                  <StatusChip tone="ok">Live backend</StatusChip>
                  <span className="engine-detail">
                    {backend.planner.kind === 'llm' ? `${backend.planner.provider} · ${backend.planner.model}` : 'runbook planner'} · {twinLabel} · server-side Proof Gate
                  </span>
                </>
              ) : (
                <>
                  <StatusChip tone="info">In-browser model twin</StatusChip>
                  <span>{PLANNER_MODE} · synthetic data only · no production access</span>
                </>
              )}
              {backend && (
                <span className="segmented" role="group" aria-label="Engine">
                  <button type="button" aria-pressed={engine === 'live'} className={engine === 'live' ? 'is-on' : ''} onClick={() => changeEngine('live')} disabled={running}>
                    Live
                  </button>
                  <button type="button" aria-pressed={engine === 'local'} className={engine === 'local' ? 'is-on' : ''} onClick={() => changeEngine('local')} disabled={running}>
                    In-browser
                  </button>
                </span>
              )}
            </p>
          </div>

          <div className="wb-controls">
            <button type="button" className={`btn-break ${running ? 'is-running' : ''}`} onClick={() => void breakNetwork()} disabled={running}>
              <span className="btn-break-glow" aria-hidden="true" />
              <Zap size={22} aria-hidden="true" />
              <span>{running ? 'Investigating…' : hasRun ? 'Break it again' : 'Break the network'}</span>
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
                    <button key={s} type="button" aria-pressed={speed === s} className={speed === s ? 'is-on' : ''} onClick={() => setSpeed(s)} disabled={engine === 'live' && running}>
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              <div className="ctrl-buttons">
                {engine === 'local' && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={skip} disabled={!running}>
                    <FastForward size={15} aria-hidden="true" /> Skip to review
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetAll} disabled={!hasRun || (engine === 'live' && running)}>
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
            <section className={`verdict-card ${verdict ? `v-${verdict.toLowerCase()}` : failedEvent ? 'v-inconclusive' : hasRun || starting ? 'v-running' : 'v-idle'}`} aria-labelledby="verdict-title">
              {!hasRun && !starting && (
                <>
                  <p className="stage-kicker">How to read this</p>
                  <h2 id="verdict-title">One button. Eight gates. Zero guesswork.</h2>
                  <p>The harness breaks the demo network with a fault TwinOps cannot see. TwinOps observes, reproduces the fault in a twin, tests fixes there, attacks its best answer and only then asks you.</p>
                </>
              )}
              {(starting || hasRun) && !verdict && !failedEvent && (
                <>
                  <p className="stage-kicker">{runId ? `Run ${runId} · seed ${seed}` : 'Contacting the backend'}</p>
                  <h2 id="verdict-title">Investigating — {frame.phase}</h2>
                  <div className="scan" aria-hidden="true" />
                  {thinking && <ModelThinking key={thinking.seq} event={thinking} />}
                  <p>Sealed fault: <span className="sealed">••••••••</span></p>
                </>
              )}
              {failedEvent && !verdict && (
                <>
                  <p className="stage-kicker">Run {runId}</p>
                  <h2 id="verdict-title" className="stamp">
                    {VERDICT_LABEL.INCONCLUSIVE}
                  </h2>
                  <p>{failedEvent.summary}</p>
                </>
              )}
              {view && verdict && (
                <>
                  <p className="stage-kicker">
                    Verdict · {view.run.runId}
                  </p>
                  <h2 id="verdict-title" className="stamp">
                    {VERDICT_LABEL[verdict]}
                  </h2>
                  {view.run.selected ? (
                    <p className="verdict-change">
                      <GitPullRequestArrow size={16} aria-hidden="true" /> {view.run.selected.change.label}
                    </p>
                  ) : (
                    <p className="verdict-change">
                      <Siren size={16} aria-hidden="true" /> Escalated with evidence — no change proposed.
                    </p>
                  )}
                  {thinking && <ModelThinking key={thinking.seq} event={thinking} />}
                  {view.narrative && (
                    <div className="briefing">
                      <p className="briefing-head">
                        <Bot size={13} aria-hidden="true" /> AI approver briefing · {view.narrative.model} · not authoritative
                      </p>
                      <p>{view.narrative.summary}</p>
                      <p className="briefing-cites">
                        {view.narrative.evidenceIds.length ? (
                          <>
                            <StatusChip tone="ok">{view.narrative.evidenceIds.length} cited IDs verified</StatusChip>
                            {view.narrative.evidenceIds.map((id) => (
                              <code key={id}>{id}</code>
                            ))}
                          </>
                        ) : (
                          <StatusChip tone="warn">cites no evidence; verify against the Proof Pack</StatusChip>
                        )}
                      </p>
                    </div>
                  )}
                  {ask && (
                    <button type="button" className="btn btn-ghost btn-sm ask-open" onClick={openAsk}>
                      <MessageSquareText size={15} aria-hidden="true" /> Ask TwinOps about this run
                    </button>
                  )}
                  {awaiting && view.run.selected && (
                    <div className="verdict-actions">
                      <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                        <ShieldCheck size={16} aria-hidden="true" /> Review &amp; approve
                      </button>
                      {canDrift && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onDrift()} disabled={drifted}>
                          <TriangleAlert size={15} aria-hidden="true" /> {drifted ? 'Drift injected' : 'Simulate drift'}
                        </button>
                      )}
                    </div>
                  )}
                  {outcome && (
                    <p className="verdict-outcome">
                      <StatusChip tone={outcome.status === 'applied' ? 'ok' : outcome.status === 'rejected_by_operator' || outcome.status === 'expired' ? 'warn' : 'fail'}>
                        {outcome.status === 'applied'
                          ? 'Applied · post-checks passed'
                          : outcome.status === 'rejected_by_operator'
                            ? 'Rejected by operator'
                            : outcome.status === 'rolled_back'
                              ? 'Rolled back'
                              : outcome.status === 'expired'
                                ? 'Approval expired'
                                : 'Apply refused'}
                      </StatusChip>
                      <span>{outcome.reason}</span>
                    </p>
                  )}
                  <button type="button" className="reveal" onClick={() => void onReveal()} aria-expanded={reveal}>
                    {reveal ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    {reveal && sealedLabel ? (
                      <span>
                        Sealed fault: <strong>{sealedLabel}</strong> — H1 was “{view.run.hypotheses[0].title}”
                      </span>
                    ) : (
                      <span>Reveal the sealed fault</span>
                    )}
                  </button>
                  <p className="verdict-meta">
                    {live
                      ? `Server compute ${(view.run.computeMs / 1000).toFixed(1)} s · ${view.run.mode} · time to verdict ${fmtClock(verdictWall ?? wall)}`
                      : `Engine compute ${view.run.computeMs} ms · paced for humans · time to verdict ${fmtClock(verdictWall ?? wall)}`}
                  </p>
                </>
              )}
            </section>
            <Timeline events={visible.filter((e) => e.kind !== 'model_call')} />
          </aside>
        </div>

        <Evidence
          view={view}
          frame={frame}
          events={visible}
          ask={ask}
          tab={evidenceTab}
          onTab={setEvidenceTab}
          inspectId={inspectId}
          onInspect={setInspectId}
          verdictVisible={verdictVisible}
          decisionVisible={Boolean(outcome)}
        />
      </main>

      {view?.run.selected && (
        <ApprovalDialog
          key={view.run.runId}
          open={dialogOpen}
          view={view}
          requirePasscode={engine === 'live' && Boolean(backend?.approvalAuth)}
          busy={decisionBusy}
          error={decisionError}
          targetLabel={live && backend?.twin.backend === 'emulated' ? 'Containerlab prod lab only' : 'demo network only'}
          onClose={() => setDialogOpen(false)}
          onDecide={(...args) => void onDecide(...args)}
        />
      )}
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
