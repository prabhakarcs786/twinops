import { Bot, Eye, EyeOff, FastForward, GitPullRequestArrow, MessageSquareText, RotateCcw, Settings2, ShieldCheck, Siren, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { createIncident as createLiveIncident, fetchConfig, getIncident, getReveal, postDecision, postDrift, subscribe, type BackendConfig, type LiveIncident, type StreamState } from '../api/live.ts';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import { FAULT_INFO, SUPPORTED_FAULTS } from '../engine/harness.ts';
import { decide, idleFrame, simulateDrift, startIncident, VERDICT_LABEL, type IncidentSession } from '../engine/orchestrator.ts';
import { PLANNER_MODE } from '../engine/planner.ts';
import { buildTopology, PACK_OPTIONS } from '../engine/topology.ts';
import type { FaultId, PackId, Phase, RunEvent, ScenarioVariant } from '../engine/types.ts';
import { useReducedMotion } from '../lib/hooks.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import { ModelThinking } from './AiTrace.tsx';
import { CandidateComparison, EvidenceReplay, ImpactSummary } from './DecisionEvidence.tsx';
import { IncidentHistory } from './IncidentHistory.tsx';
import { BenchmarkPanel } from './BenchmarkPanel.tsx';
import { ReviewMetrics } from './ReviewTrial.tsx';
import { DecisionReview } from './DecisionReview.tsx';
import { ConnectedApplication, ConnectedApplicationContext } from './ConnectedApplication.tsx';
import { WorkbenchLoading } from './WorkbenchLoading.tsx';
import { useConnection } from './useConnection.ts';
import { Evidence, type AskTarget, type EvidenceTab } from './Evidence.tsx';
import { CandidateBoard, Counters, PhaseStepper, Stage, Timeline } from './panels.tsx';
import { CONNECTED_TARGET, DEMO_TARGET, liveView, localView, type RunView } from './runView.ts';
import { fmtClock, usePlayback } from './usePlayback.ts';

const SPEEDS = [0.5, 1, 2, 4];
const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id);
const ANNOUNCE = new Set(['fault_injected', 'model_call', 'reproduced', 'not_reproduced', 'gate_verdict', 'awaiting_approval', 'escalated', 'apply_progress', 'post_check', 'drift_detected', 'rolled_back', 'approval_rejected', 'run_failed', 'recovery_required']);
const OUTCOME_KINDS = new Set(['post_check', 'rolled_back', 'drift_detected', 'approval_rejected', 'recovery_required']);

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const fault = p.get('fault') as FaultId | null;
  return {
    speed: p.get('speed') === 'instant' ? Infinity : SPEEDS.includes(Number(p.get('speed'))) ? Number(p.get('speed')) : 1,
    fault: fault && fault in FAULT_INFO ? fault : 'random',
    autostart: p.get('autostart') === '1',
    pack: (p.get('pack') === 'branch' ? 'branch' : p.get('pack') === 'enterprise' ? 'enterprise' : 'core') as PackId,
    engine: p.get('incident') ? 'live' : p.get('engine') === 'local' ? 'local' : 'live',
    incident: p.get('incident'),
    presentation: p.get('view') === 'presentation',
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
  createdAt: number;
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
  const [starting, setStarting] = useState(Boolean(params.incident));
  const [presentation, setPresentation] = useState(params.presentation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [challengeSettingsOpen, setChallengeSettingsOpen] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>('closed');
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [revealed, setRevealed] = useState<{ code: string; label: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>('facts');
  const [condition, setCondition] = useState<ScenarioVariant | 'provider_outage'>('standard');
  const [useMemory, setUseMemory] = useState(true);
  const [seedInput, setSeedInput] = useState('');
  const [drifted, setDrifted] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<'decision' | 'investigation'>('decision');
  const [followExercise, setFollowExercise] = useState(false);
  const watching = Boolean(backend?.connectedApplication || incident?.kind === 'live' && incident.detail?.run?.source?.kind === 'connected_application');
  const { connection, error: connectionError, setConnection } = useConnection(watching);
  const measured = Boolean(!connectionError && connection?.connected && connection.ready && connection.probes?.length);
  const topo = useMemo(() => incident?.kind === 'live' && incident.detail?.run?.topology || (watching && connection?.topology) || buildTopology(pack), [pack, incident, watching, connection?.topology]);
  // An incident retains its origin even when the current config request fails.
  const engine: 'live' | 'local' = incident?.kind ?? (enginePref === 'live' && (backend || params.incident) ? 'live' : 'local');

  const local = incident?.kind === 'local' ? incident : null;
  const live = incident?.kind === 'live' ? incident : null;
  const session = local?.session ?? null;
  const events = useMemo(() => incident?.events ?? [], [incident]);
  const playback = usePlayback(local ? events : [], speed);
  const { reset, skip } = playback;

  const index = live ? events.length : playback.index;
  const visible = live ? events : events.slice(0, index);
  const current = visible.at(-1);
  const baseline = idleFrame(topo);
  if (watching || backend === undefined || starting || resumeError) {
    baseline.prod = {
      probes: measured ? Object.fromEntries(connection!.probes!.map((p) => [p.id, p])) : {},
      alarmNodes: measured ? connection!.alarmNodes ?? [] : [],
      status: measured && connection!.probes!.some((p) => !p.ok) ? 'incident' : 'healthy',
    };
  }
  const frame = current?.frame ?? baseline;
  const seen = new Set<Phase>(visible.map((e) => e.phase));
  const verdictEvent = visible.find((e) => e.kind === 'gate_verdict');
  const failedEvent = live ? visible.find((e) => e.kind === 'run_failed') : undefined;
  const wall = live ? Math.max(current?.at ?? 0, !verdictEvent && !failedEvent && !live.ended ? now - live.createdAt * 1000 : 0) : playback.wall;
  const verdictWall = verdictEvent ? (live ? verdictEvent.at : (playback.marks[verdictEvent.seq] ?? wall)) : null;

  const view: RunView | null = local
    ? localView(local.session)
    : live?.detail?.run
      ? liveView(live.id, live.detail.run, live.detail.outcome, live.detail.approval, visible.some((e) => e.kind === 'narrative') ? live.detail.narrative : null)
      : null;
  const verdictVisible = Boolean(verdictEvent) && Boolean(view);
  const latestLifecycle = [...events].reverse().find((event) => event.lifecycle)?.lifecycle;
  const detailLifecycle = live?.detail?.lifecycle;
  const serverLifecycle = detailLifecycle && detailLifecycle.revision >= (latestLifecycle?.revision ?? 0) ? detailLifecycle : latestLifecycle;
  const evidenceExpired = serverLifecycle && now / 1000 > serverLifecycle.evidenceExpiresAt;
  const lifecycle = serverLifecycle && evidenceExpired ? { ...serverLifecycle, evidenceFresh: false, canApprove: false,
    nextAction: 'Start a fresh investigation' } : serverLifecycle;
  const liveOutcomeVisible = Boolean(live?.ended || live?.detail?.recovered) || (current ? OUTCOME_KINDS.has(current.kind) : false);
  const outcome = local ? (session?.outcome && playback.done ? session.outcome : undefined) : liveOutcomeVisible ? (live?.detail?.outcome ?? undefined) : undefined;
  const applyStep = live && !outcome && current && ['approval_recorded', 'apply_progress', 'applied'].includes(current.kind) ? current : null;
  const decided = visible.some((e) => e.kind === 'approval_recorded' || e.kind === 'applied' || OUTCOME_KINDS.has(e.kind));
  const awaiting = live && lifecycle ? lifecycle.canReject : visible.some((e) => e.kind === 'awaiting_approval') && !decided && !view?.outcome && !outcome && !live?.detail?.recovered;
  const running = local ? !playback.done : live && lifecycle ? lifecycle.status === 'running' || lifecycle.status === 'applying' : live ? !verdictEvent && !failedEvent && !live.ended : starting;
  const showInvestigation = !live || !verdictVisible || workspaceTab === 'investigation';
  const hasRun = Boolean(incident);

  const ticking = Boolean(live && (running || awaiting));
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const rememberIncident = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) { url.searchParams.set('incident', id); url.searchParams.delete('autostart'); }
    else url.searchParams.delete('incident');
    window.history.replaceState(null, '', url);
  };

  const clearRunState = () => {
    reset();
    setReveal(false);
    setRevealed(null);
    setInspectId(null);
    setDrifted(false);
    setDecisionError(null);
    setDialogOpen(false);
    setResumeError(null);
    setWorkspaceTab('decision');
  };

  const resumeIncident = async (id: string) => {
    setStarting(true);
    setResumeError(null);
    setIncident(null);
    clearRunState();
    try {
      const detail = await getIncident(id);
      setPack(detail.pack);
      setEnginePref('live');
      // Render recorded evidence immediately; the stream deduplicates replayed events by sequence.
      setIncident({ kind: 'live', id, eventsUrl: `/api/incidents/${encodeURIComponent(id)}/events`, seed: detail.seed,
        events: detail.run?.events ?? [], detail, ended: false, createdAt: detail.createdAt });
      rememberIncident(id);
    } catch (err) { setResumeError(`Could not resume this incident — ${errorText(err)}`); }
    finally { setStarting(false); }
  };
  const initialResume = useEffectEvent(() => { if (params.incident) void resumeIncident(params.incident); });
  useEffect(() => {
    if (!params.incident || backend === undefined) return;
    const timer = window.setTimeout(() => initialResume(), 0);
    return () => window.clearTimeout(timer);
  }, [params.incident, backend]);

  // Connected mode: TwinOps starts investigations itself, so this view follows them instead of waiting for a link.
  const activeId = connection?.issues.find((issue) => issue.incidentId &&
    (issue.investigationStatus === 'investigating' || issue.status === 'open' && !issue.investigationStatus))?.incidentId ?? null;
  const followActive = useEffectEvent((id: string) => {
    if (!incident && !starting && (!params.incident || followExercise)) void resumeIncident(id);
  });
  useEffect(() => {
    if (!watching || !activeId) return;
    const timer = window.setTimeout(() => followActive(activeId), 0);
    return () => window.clearTimeout(timer);
  }, [watching, activeId]);

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
      setStreamState,
    );
  }, [liveId, liveUrl, streamAttempt]);

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
      .catch((err: unknown) => { if (alive) setResumeError(`Could not refresh incident evidence — ${errorText(err)}`); });
    return () => {
      alive = false;
    };
  }, [liveId, needDetail, liveCount, liveEnded]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);



  const breakNetwork = async () => {
    const requestedSeed = seedInput.trim() ? Number(seedInput) : undefined;
    if (requestedSeed !== undefined && (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 1_000_000)) {
      setToast('Seed must be a whole number between 0 and 1000000.');
      return;
    }
    clearRunState();
    rememberIncident(null);
    if (engine === 'local') {
      setIncident(createLocalIncident(pack, faultChoice));
      return;
    }
    setIncident(null);
    setStarting(true);
    try {
      const challengesAvailable = backend?.harness && backend.twin.backend === 'model';
      const created = await createLiveIncident({ pack, fault: faultChoice, pace: Number.isFinite(speed) ? speed : 0, seed: requestedSeed,
        useMemory, variant: challengesAvailable && condition !== 'provider_outage' ? condition : 'standard',
        simulateOutage: Boolean(challengesAvailable && condition === 'provider_outage') });
      setIncident({ kind: 'live', id: created.incidentId, eventsUrl: created.eventsUrl, seed: created.seed, events: [], detail: null, ended: false, createdAt: created.createdAt });
      rememberIncident(created.incidentId);
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
    if (!params.autostart || params.incident || backend === undefined || backend?.connectedApplication) return;
    const t = window.setTimeout(() => onAutostart(), 0);
    return () => window.clearTimeout(t);
  }, [params.autostart, params.incident, backend]);

  const resetAll = () => {
    clearRunState();
    setIncident(null);
    rememberIncident(null);
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
  const twinLabel = (view?.run.versions.twin ?? backend?.twin.backend) === 'emulated' ? 'Containerlab emulated twin' : 'model twin';
  const connected = view?.run.source ? view.run.source.kind === 'connected_application' : Boolean(backend?.connectedApplication);
  const connectedControls = connected || Boolean(backend?.connectedApplication);
  const resolving = backend === undefined;
  const followingIncident = Boolean(!incident && !resumeError && activeId && (!params.incident || followExercise));
  const loadingIncident = starting || followingIncident || Boolean(live && !current && !view && !live.ended);
  const loadingWorkspace = resolving || loadingIncident || Boolean(!hasRun && watching && !connection && !connectionError);
  const target = connected ? CONNECTED_TARGET : DEMO_TARGET;
  const canInvestigate = engine === 'local' || Boolean(backend && (!backend.authenticationRequired || backend.role === 'investigator' || backend.role === 'approver'));
  const canDrift = engine === 'local' || Boolean(backend?.harness && !backend.approvalAuth && (!backend.authenticationRequired || backend.role === 'approver'));
  const thinking = current?.kind === 'model_call' ? current : undefined;
  const activePlanner = view?.run.planner ?? backend?.planner;
  const ask: AskTarget | null = canInvestigate && live && !live.detail?.recovered && activePlanner?.kind === 'llm' && activePlanner.provider !== 'simulated-outage'
    ? { incidentId: live.id, model: activePlanner.model, ready: Boolean(view) } : null;
  const openAsk = () => {
    setEvidenceTab('ask');
    window.setTimeout(() => document.getElementById('ask-input')?.focus(), 50);
  };

  return (
    <div className={`wb ${presentation ? 'is-presentation' : ''}`}>
      <SiteHeader variant="app" theme={theme} onToggleTheme={onToggleTheme} />
      <main id="main" className="wb-main" tabIndex={-1}>
        <header className="wb-heading">
          <div className="wb-title">
            <h1>{verdictVisible ? 'Incident review' : hasRun || loadingIncident ? 'Investigation' : 'Workbench'}</h1>
            <div className="mode-line" aria-busy={resolving}>
              {resolving ? <StatusChip tone="pending">Checking connection…</StatusChip>
                : engine === 'live' ? <StatusChip tone={backend ? 'ok' : 'info'}>{live?.detail?.recovered ? 'Saved backend evidence' : backend ? 'Live backend' : 'Backend evidence'}</StatusChip>
                : <StatusChip tone="info">In-browser model twin</StatusChip>}
              {connected && <span>Metro Network</span>}
              {!resolving && <details className="runtime-details">
                <summary>Runtime details</summary>
                <div className="runtime-content">
                  <p>{engine === 'live'
                    ? `${activePlanner?.kind === 'llm' ? `${activePlanner.provider} · ${activePlanner.model}` : 'Runbook planner'} · ${twinLabel} · server-side Proof Gate`
                    : `${PLANNER_MODE} · synthetic data only · no production access`}</p>
                  {engine === 'live' && !backend && <p>Current backend configuration is unavailable. The incident keeps its recorded source.</p>}
                  {backend && !backend.connectedApplication && !connected && <div className="segmented" role="group" aria-label="Engine">
                    <button type="button" aria-pressed={engine === 'live'} className={engine === 'live' ? 'is-on' : ''} onClick={() => changeEngine('live')} disabled={running}>Live</button>
                    <button type="button" aria-pressed={engine === 'local'} className={engine === 'local' ? 'is-on' : ''} onClick={() => changeEngine('local')} disabled={running}>In-browser</button>
                  </div>}
                </div>
              </details>}
            </div>
          </div>
          <div className="workbench-toolbar">
            {!loadingWorkspace && !resumeError && !connectedControls && <>
              <button type="button" className={`btn-break ${running ? 'is-running' : ''}`} onClick={() => void breakNetwork()} disabled={running || starting || !canInvestigate}>
                <Zap size={16} aria-hidden="true" /><span>{running ? 'Investigating…' : hasRun ? 'Break it again' : 'Break the network'}</span>
              </button>
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={settingsOpen} aria-controls="scenario-settings" onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} aria-hidden="true" />Scenario settings</button>
            </>}
            {(backend || live) && <IncidentHistory onResume={(id) => void resumeIncident(id)} disabled={running || starting} current={live?.id} />}
            {hasRun && <button type="button" className="btn btn-ghost btn-sm" aria-pressed={presentation} onClick={() => setPresentation(!presentation)}>Presentation view</button>}
            {!connected && hasRun && <>
              {engine === 'local' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={skip} disabled={!running}>
                  <FastForward size={15} aria-hidden="true" /> Skip to review
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={resetAll} disabled={engine === 'live' && running}>
                <RotateCcw size={15} aria-hidden="true" /> Reset
              </button>
            </>}
          </div>
          {live && <div className="workbench-status">
            <span className="connection-state" role="status">{live.detail?.recovered ? 'Saved incident · retained for review' : live.ended ? 'Evidence synchronized' : streamState === 'connected' ? 'Live events connected' : streamState === 'reconnecting' ? 'Connection lost · reconnecting…' : 'Connecting to incident…'}</span>
            {!live.detail?.recovered && !live.ended && ['closed', 'reconnecting'].includes(streamState) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStreamAttempt((n) => n + 1)}>Reconnect</button>}
            {verdictVisible && backend?.harness && <a className="btn btn-ghost btn-sm" href={`/review?incident=${encodeURIComponent(live.id)}`} target="_blank" rel="noreferrer">Review trial (new tab)</a>}
            {!loadingWorkspace && connectedControls && <ConnectedApplicationContext connection={connection} error={connectionError} networkUrl={backend?.networkUrl} />}
            {connectedControls && !running && !awaiting && !activeId && <a className="workbench-home-link" href="/workbench">Back to workbench</a>}
          </div>}
        </header>
        {resumeError && <div className="recovery-notice" role="alert"><p>{resumeError}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void resumeIncident(live?.id ?? params.incident ?? activeId ?? '')}>Retry loading evidence</button><a className="btn btn-ghost btn-sm" href="/workbench">Back to workbench</a></div>}
        {loadingWorkspace ? <WorkbenchLoading incident={loadingIncident} /> : !resumeError && <>
        <section className="wb-metrics" aria-label="Investigation metrics">
          <PhaseStepper seen={seen} current={frame.phase} escalated={verdict === 'ESCALATE'} />
          <Counters frame={frame} wall={wall} verdictAt={verdictVisible ? verdictWall : null} target={target} idle={!hasRun} />
        </section>
        {!resolving && !connectedControls && <section id="scenario-settings" className="wb-settings" aria-label="Scenario settings" hidden={!settingsOpen}>
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
            </div>
            {engine === 'live' && <details className="challenge-controls" open={challengeSettingsOpen} onToggle={(event) => setChallengeSettingsOpen(event.currentTarget.open)}>
              <summary>Challenge conditions &amp; memory</summary>
              <div className="challenge-settings">
                {backend?.harness && backend.twin.backend === 'model' && <label className="field"><span>Challenge conditions</span>
                  <select value={condition} onChange={(event) => setCondition(event.target.value as ScenarioVariant | 'provider_outage')} disabled={running}>
                    {(backend.variants ?? [{ id: 'standard', label: 'Standard fixture' }]).map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
                    <option value="provider_outage">Simulated provider outage (no model call)</option>
                  </select>
                </label>}
                <label className="field"><span>Seed (optional)</span><input type="number" inputMode="numeric" min={0} max={1000000} step={1} placeholder="Random" value={seedInput} onChange={(event) => setSeedInput(event.target.value)} disabled={running} /></label>
                <label className="memory-toggle"><input type="checkbox" checked={useMemory} onChange={(event) => setUseMemory(event.target.checked)} disabled={running} />Retest compatible historical fixes</label>
              </div>
            </details>}
        </section>}
        {connected && activeId && incident && activeId !== live?.id && (
          <div className="follow-notice" role="status">
            <span className="follow-dot" aria-hidden="true" />
            <p>Metro Network has a new incident under investigation.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void resumeIncident(activeId)} disabled={starting}>Follow live investigation</button>
          </div>
        )}
        {view?.run.exercise === 'provider_outage' && <p className="recovery-notice" role="status">Simulated provider outage. No model request was sent; the runbook fallback was tested through the same gates.</p>}
        {view?.run.variant && view.run.variant !== 'standard' && <p className="scenario-notice">Scenario variant: {backend?.variants?.find((variant) => variant.id === view.run.variant)?.label ?? view.run.variant.replaceAll('_', ' ')}</p>}
        {hasRun && current && showInvestigation && <ImpactSummary frame={frame} view={view} ready={verdictVisible} target={target} />}
        {live && verdictVisible && <div className="segmented workspace-views" role="group" aria-label="Workbench view">
          <button type="button" className={workspaceTab === 'decision' ? 'is-on' : ''} aria-pressed={workspaceTab === 'decision'} onClick={() => setWorkspaceTab('decision')}>Decision review</button>
          <button type="button" className={workspaceTab === 'investigation' ? 'is-on' : ''} aria-pressed={workspaceTab === 'investigation'} onClick={() => setWorkspaceTab('investigation')}>Investigation detail</button>
        </div>}
        <div className={`wb-grid ${showInvestigation || !hasRun ? '' : 'decision-layout'}`}>
          <div className="wb-aside">
            {(hasRun || starting || !connectedControls) && <section className={`verdict-card ${verdict ? `v-${verdict.toLowerCase()}` : failedEvent ? 'v-inconclusive' : hasRun || starting ? 'v-running' : 'v-idle'}`} aria-labelledby="verdict-title">
              {!hasRun && !starting && <>
                <p className="stage-kicker">{resolving ? 'Connecting' : 'Simulation workspace'}</p>
                <h2 id="verdict-title">{resolving ? 'Checking your connection' : 'Ready to investigate'}</h2>
                <p>{resolving ? 'Loading the network and available controls…' : 'Choose a scenario and break the demo network. Follow each stage above as TwinOps reproduces the incident and tests a repair.'}</p>
                {!resolving && <p className="application-note">{PACK_OPTIONS.find((p) => p.id === pack)?.name} · {faultChoice === 'random' ? 'Random sealed fault' : FAULT_INFO[faultChoice].label}</p>}
              </>}
              {(starting || hasRun) && !verdict && !failedEvent && (
                <>
                  <p className="stage-kicker" title={runId || undefined}>{runId ? `Run ${shortId(runId)} · seed ${seed}` : 'Contacting the backend'}</p>
                  <h2 id="verdict-title">Investigating — {frame.phase}</h2>
                  <div className="scan" aria-hidden="true" />
                  {thinking && <ModelThinking key={thinking.seq} event={thinking} />}
                  <p>{connected ? 'Source: Metro Network · observed through its API' : <>Sealed fault: <span className="sealed">••••••••</span></>}</p>
                </>
              )}
              {failedEvent && !verdict && (
                <>
                  <p className="stage-kicker" title={runId}>Run {shortId(runId)}</p>
                  <h2 id="verdict-title" className="stamp">
                    {VERDICT_LABEL.INCONCLUSIVE}
                  </h2>
                  <p>{failedEvent.summary}</p>
                </>
              )}
              {view && verdict && (
                <>
                  <p className="stage-kicker" title={view.run.runId}>
                    Verdict · {shortId(view.run.runId)}
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
                  {awaiting && view.run.selected && (!backend?.authenticationRequired || backend.role === 'approver') && (
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
                  {applyStep && (
                    <div className="apply-progress" role="status">
                      <StatusChip tone={applyStep.tone === 'fail' ? 'fail' : 'pending'}>{applyStep.tone === 'fail' ? 'Rolling back' : 'Applying approved change'}</StatusChip>
                      <p><strong>{applyStep.title}</strong> · {applyStep.summary}</p>
                      <div className="scan" aria-hidden="true" />
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
                                : outcome.status === 'recovery_required' ? 'Operator recovery required' : 'Apply refused'}
                      </StatusChip>
                      <span>{outcome.reason}</span>
                    </p>
                  )}
                  {view.narrative && (
                    <div className="briefing">
                      <p className="briefing-head">
                        <Bot size={13} aria-hidden="true" /> AI approver briefing · {view.narrative.model} · not authoritative
                      </p>
                      <p>{view.narrative.summary}</p>
                      <p className="briefing-cites">
                        {view.narrative.evidenceIds.length ? (
                          <>
                            <StatusChip tone="ok">{view.narrative.evidenceIds.length} source IDs found · claims need review</StatusChip>
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
                  {connected ? (
                    <p className="verdict-source">
                      Source: Metro Network · TwinOps received observations, not a fault label.
                    </p>
                  ) : (
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
                  )}
                  <p className="verdict-meta">
                    {live
                      ? `Server compute ${(view.run.computeMs / 1000).toFixed(1)} s · ${view.run.mode} · time to verdict ${fmtClock(verdictWall ?? wall)}`
                      : `Engine compute ${view.run.computeMs} ms · paced for humans · time to verdict ${fmtClock(verdictWall ?? wall)}`}
                  </p>
                </>
              )}
            </section>}
            {verdictVisible && !showInvestigation && <ImpactSummary frame={frame} view={view} ready target={target} />}
            {connectedControls && !hasRun && <ConnectedApplication connection={connection} error={connectionError} canOperate={canInvestigate}
              networkUrl={backend?.networkUrl} onUpdate={setConnection} onExercise={() => { resetAll(); setFollowExercise(true); }} />}
            {showInvestigation && hasRun && <Timeline events={visible.filter((e) => e.kind !== 'model_call')} />}
          </div>
          {(showInvestigation || !hasRun) && <div className="wb-left">
            <Stage topo={topo} frame={frame} animate={!reduced} target={target} unavailable={!current && (resolving || watching && !measured || !watching && (starting || Boolean(resumeError)))} />
            {frame.candidates.length > 0 && <CandidateBoard frame={frame} onInspect={(id) => { setInspectId(id); setEvidenceTab('gate'); document.getElementById('evidence')?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' }); }} />}
          </div>}
        </div>
        {verdictVisible && view && <DecisionReview view={view} lifecycle={lifecycle} />}
        {verdictVisible && view && <CandidateComparison view={view} onInspect={(id) => { setInspectId(id); setEvidenceTab('gate'); document.getElementById('evidence')?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' }); }} />}
        {verdictVisible && showInvestigation && <EvidenceReplay key={runId} events={visible} />}


        {hasRun && <Evidence
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
        />}
        {backend && hasRun && <BenchmarkPanel />}
        {backend?.harness && hasRun && <ReviewMetrics />}
        </>}
      </main>

      {view?.run.selected && (
        <ApprovalDialog
          key={view.run.runId}
          open={dialogOpen}
          view={view}
          requirePasscode={engine === 'live' && Boolean(backend?.approvalAuth)}
          canApprove={!live || Boolean(lifecycle?.canApprove) && (!backend?.authenticationRequired || backend.role === 'approver')}
          busy={decisionBusy}
          error={decisionError}
          targetLabel={connected ? 'Metro Network (Containerlab prod lab) only' : live && backend?.twin.backend === 'emulated' ? 'Containerlab prod lab only' : 'demo network only'}
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
