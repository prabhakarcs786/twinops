import { CATALOGUE_VERSION, describeStep, POLICY_VERSION } from './catalogue.ts';
import { DemoNetwork } from './harness.ts';
import { healthyState, sampleJourney } from './model.ts';
import { diagnose, guardUntrusted, PLANNER_MODE, PLANNER_VERSION, proposeCandidates, reviseCandidate, selectChallenges } from './planner.ts';
import { sha256, shortHash } from './sha256.ts';
import { buildTopology, pops } from './topology.ts';
import { createContext, evaluateGates, reproduce, runChallenge, runExperiment } from './twin.ts';
import type {
  Actor,
  ApprovalRecord,
  CandidateRecord,
  ChallengeResult,
  ChangeSet,
  EventKind,
  FaultId,
  Frame,
  Hypothesis,
  LogLine,
  Observation,
  PackId,
  Phase,
  ProbeResult,
  Reproduction,
  RunEvent,
  Tone,
  Topology,
  Verdict,
  Versions,
} from './types.ts';

export const ENGINE_VERSION = 'twinops-model-twin-0.1.0';
export const MAX_CANDIDATES = 4;
export const MAX_REVISIONS = 2;

export const VERDICT_LABEL: Record<Verdict, string> = {
  PASS_UNDER_DEFINED_TESTS: 'PASS UNDER DEFINED TESTS',
  PASS_WITH_WARNINGS: 'PASS WITH WARNINGS',
  REJECTED: 'REJECTED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  ESCALATE: 'ESCALATE',
};

export interface RunOptions {
  pack: PackId;
  fault: FaultId;
  seed: number;
  includeEvaluationCase?: boolean;
}

export interface RunResult {
  runId: string;
  seed: number;
  pack: PackId;
  versions: Versions;
  mode: string;
  topology: Topology;
  observation: Observation;
  guardedLogs: LogLine[];
  hypotheses: Hypothesis[];
  diagnostics: ProbeResult[];
  reproduction: Reproduction;
  candidates: CandidateRecord[];
  selected?: CandidateRecord;
  verdict: Verdict;
  untested: string[];
  events: RunEvent[];
  computeMs: number;
  snapshotHash: string;
  /** PoPs whose IPv6 prefix was live in the captured state; post-checks keep them reachable. */
  v6Pops: string[];
  /** Non-harness writes to the demo network between break and verdict. Must be 0. */
  writesDuringDiagnosis: number;
}

export interface ApplyOutcome {
  status: 'applied' | 'rolled_back' | 'refused' | 'rejected_by_operator';
  reason: string;
  postChecks: ProbeResult[];
}

export interface IncidentSession {
  run: RunResult;
  demo: DemoNetwork;
  approval?: ApprovalRecord;
  outcome?: ApplyOutcome;
  postEvents: RunEvent[];
}

export function idleFrame(topo: Topology): Frame {
  const healthy = healthyState(topo);
  return {
    phase: 'idle',
    prod: { probes: Object.fromEntries(topo.journeys.map((j) => [j.id, sampleJourney(healthy, topo, j)])), alarmNodes: [], status: 'healthy' },
    twin: null,
    hypotheses: [],
    candidates: [],
    counters: { experiments: 0, revisions: 0, unsafeRejected: 0, probesRun: 0, challengesRun: 0, productionWritesDuringDiagnosis: 0 },
  };
}

class Recorder {
  events: RunEvent[] = [];
  at: number;
  seq: number;
  frame: Frame;
  private demo: DemoNetwork;

  constructor(frame: Frame, demo: DemoNetwork, at = 0, seq = 0) {
    this.frame = structuredClone(frame);
    this.demo = demo;
    this.at = at;
    this.seq = seq;
  }

  push(delay: number, kind: EventKind, phase: Phase, actor: Actor, tone: Tone, title: string, summary: string, raw: unknown, mutate?: (f: Frame) => void) {
    this.at += delay;
    mutate?.(this.frame);
    this.frame.phase = phase;
    this.frame.counters.productionWritesDuringDiagnosis = this.demo.writes.filter((w) => w.actor !== 'harness' && !w.approvalToken).length;
    this.seq += 1;
    this.events.push({ seq: this.seq, at: this.at, kind, phase, actor, tone, title, summary, raw, frame: structuredClone(this.frame) });
  }
}

const byId = (probes: ProbeResult[]) => Object.fromEntries(probes.map((p) => [p.id, p]));

function upsertCandidate(frame: Frame, summary: Frame['candidates'][number]) {
  const i = frame.candidates.findIndex((c) => c.id === summary.id);
  if (i >= 0) frame.candidates[i] = summary;
  else frame.candidates.push(summary);
}

function untestedConditions(topo: Topology, repro: Reproduction): string[] {
  const outside = pops(topo).filter((p) => !repro.slice.includes(p.id));
  return [
    'Vendor OS behaviour beyond the modelled routing, DNS and TLS functions (model twin).',
    'Routing convergence timing and transient packet loss during the change.',
    'Load above the ×3 surge challenge and concurrent faults other than the tested secondary failure.',
    'Physical layer: optics, CRC errors and link flaps are outside twin fidelity.',
    ...(outside.length ? [`Journeys from ${outside.map((p) => p.short).join(', ')} were outside the twin slice and not individually tested.`] : []),
  ];
}

export function startIncident(opts: RunOptions): IncidentSession {
  const t0 = performance.now();
  const topo = buildTopology(opts.pack);
  const demo = new DemoNetwork(topo, opts.seed);
  const rec = new Recorder(idleFrame(topo), demo);
  const runId = `inc-${sha256(`${opts.pack}|${opts.seed}|${opts.fault}|${Date.now()}`).slice(0, 6)}`;
  const versions: Versions = { engine: ENGINE_VERSION, topology: topo.version, catalogue: CATALOGUE_VERSION, policy: POLICY_VERSION, planner: PLANNER_VERSION };

  // 1. Break (harness) and observe (read-only).
  demo.injectFault(opts.fault);
  const obs = demo.observe();
  const failing = obs.probes.filter((p) => p.kind === 'journey' && !p.ok);
  const prodFrame = (f: Frame) => {
    f.prod = { probes: byId(obs.probes.filter((p) => p.kind === 'journey')), alarmNodes: [...new Set(obs.alarms.map((a) => a.node))], status: 'incident' };
  };
  rec.push(0, 'fault_injected', 'break', 'harness', 'fail', 'Network broken — fault label sealed', `${failing.length} of ${topo.journeys.length} customer journeys failing. TwinOps receives observations only, never the fault label.`, { harness: demo.writes[0], sealed: true }, prodFrame);
  rec.push(
    2200,
    'observed',
    'observe',
    'observer',
    'prod',
    'Read-only snapshot captured',
    `${obs.rawEventCount} raw events aggregated into ${obs.alarms.length} alarms · ${obs.changes.length} change records · state ${shortHash(obs.stateHash)}`,
    obs,
  );

  const guardedLogs = guardUntrusted(obs.logs);
  const flagged = guardedLogs.filter((l) => l.flagged);
  rec.push(
    2600,
    'guard',
    'observe',
    'guard',
    flagged.length ? 'warn' : 'info',
    flagged.length ? 'Instruction-like text quarantined' : 'Untrusted text scanned',
    flagged.length
      ? `${flagged.length} log line tried to instruct the agent. It is kept as evidence data and cannot select tools, skip tests or change policy.`
      : 'No instruction-like content in logs.',
    { flagged, policy: 'logs are data; tool selection is restricted to the typed catalogue' },
  );

  // 2. Diagnose.
  const captured = demo.captureSupported();
  const { hypotheses, diagnostics } = diagnose(obs, topo, {
    directIp: (id) => {
      const journey = topo.journeys.find((j) => j.id === id)!;
      const pinned = structuredClone(captured);
      pinned.clients.hosts = { [journey.host]: { 'svc.demo': '10.40.0.10', 'api.demo': '10.40.0.11' }[journey.host]! };
      return { ...sampleJourney(pinned, topo, journey), id: `DIAG-${id}`, kind: 'diagnostic', label: `${journey.id} direct-IP diagnostic (bypass DNS)` };
    },
  });
  rec.push(1400, 'hypotheses', 'diagnose', 'diagnosis', 'ai', `${hypotheses.length} ranked hypotheses`, `H1 · ${hypotheses[0].title}. ${hypotheses[0].rationale}.`, { hypotheses, diagnostics, planner: PLANNER_MODE }, (f) => {
    f.hypotheses = hypotheses;
  });

  // 3. Reproduce in the twin.
  const ctx = createContext(obs, topo, captured);
  rec.push(
    3000,
    'twin_ready',
    'reproduce',
    'twin',
    'twin',
    'Twin slice created',
    `${ctx.slice.length} of ${topo.nodes.length} nodes · ${topo.version} · captured state ${shortHash(obs.stateHash)}. Production stays read-only.`,
    { slice: ctx.slice, journeys: ctx.journeys.map((j) => j.id), capturedHash: obs.stateHash },
    (f) => {
      f.twin = { slice: ctx.slice, probes: {}, failedNodes: [], focus: [], caption: 'Loading captured state…', state: 'building' };
    },
  );
  const repro = reproduce(ctx);
  rec.push(
    2600,
    repro.passed ? 'reproduced' : 'not_reproduced',
    'reproduce',
    'twin',
    repro.passed ? 'ok' : 'fail',
    repro.passed ? 'Fault reproduced in twin' : 'Fault NOT reproduced in twin',
    repro.passed
      ? `${repro.matched}/${repro.total} symptoms match, including every affected journey. ${repro.outOfScope.length} hardware alarms are outside twin fidelity.`
      : `${repro.matched}/${repro.total} symptoms match. ${repro.mismatches[0] ?? ''}. Without reproduction no fix can be verified.`,
    repro,
    (f) => {
      f.twin = { ...f.twin!, probes: byId(repro.twinProbes.filter((p) => p.kind === 'journey')), caption: repro.passed ? 'Fault reproduced' : 'Reproduction failed', state: repro.passed ? 'reproduced' : 'not_reproduced' };
    },
  );

  // 4. Experiment → challenge → gate.
  const records: CandidateRecord[] = [];
  if (repro.passed) {
    const queue: ChangeSet[] = proposeCandidates(hypotheses[0], captured, obs, topo, opts.includeEvaluationCase ?? true).slice(0, MAX_CANDIDATES);
    let revisions = 0;
    while (queue.length) {
      const change = queue.shift()!;
      const exp = runExperiment(ctx, change);
      const forbidden = exp.forbidden.length > 0;
      const base = { id: change.id, label: change.label, origin: change.origin, forbidden };
      const restoredCount = ctx.affectedIds.filter((id) => exp.fixed.find((p) => p.id === id)?.ok).length;
      rec.push(
        2600,
        'experiment_result',
        'experiment',
        'experiment',
        exp.restored && exp.regressions.length === 0 ? 'ok' : exp.restored ? 'warn' : 'fail',
        `${change.label}${change.origin === 'evaluation_case' ? ' (evaluation case)' : ''}`,
        exp.errors.length
          ? `Rejected before execution: ${exp.errors.join('; ')}`
          : `${change.steps.map(describeStep).join(' + ')} → restored ${restoredCount}/${ctx.affectedIds.length} affected journeys${exp.regressions.length ? ` · ${exp.regressions.map((p) => `${p.id} failed`).join(', ')}` : ''}${exp.latencyDeltaMs ? ` · +${exp.latencyDeltaMs} ms` : ''}.`,
        { change, diff: exp.diff, fixed: exp.fixed, errors: exp.errors },
        (f) => {
          f.counters.experiments += 1;
          f.counters.probesRun += exp.fixed.length;
          f.twin = { ...f.twin!, probes: byId(exp.fixed.filter((p) => p.kind === 'journey')), failedNodes: [], focus: exp.touched, caption: change.label, state: 'experiment' };
          upsertCandidate(f, { ...base, status: 'testing', note: exp.restored ? 'restores affected journeys' : 'does not restore' });
        },
      );

      let challenges: ChallengeResult[] | null = null;
      let revision: ChangeSet | null = null;
      if (exp.restored && exp.regressions.length === 0 && !forbidden) {
        challenges = [];
        for (const kind of selectChallenges(change)) {
          const result = runChallenge(ctx, exp, kind);
          challenges.push(result);
          const failedNode = kind === 'secondary_failure' ? (result.detail.match(/^with (\S+) down/)?.[1] ?? '') : '';
          rec.push(1500, 'challenge_probe', 'challenge', 'challenge', result.ok ? 'ok' : result.soft ? 'warn' : 'fail', `Challenge · ${result.label}`, result.detail, result, (f) => {
            f.counters.challengesRun += 1;
            f.counters.probesRun += result.probes.length;
            const probes = { ...f.twin!.probes };
            for (const p of result.probes) {
              const baseId = p.id.replace(/-(v6|sf|surge|warm)$/, '');
              probes[baseId] = { ...p, id: baseId };
            }
            f.twin = { ...f.twin!, probes, failedNodes: failedNode ? [failedNode] : [], caption: `Challenge: ${result.label}`, state: 'challenge' };
            upsertCandidate(f, { ...base, status: 'challenging', note: result.ok ? `${result.label} survived` : `${result.label}: weakness found` });
          });
        }
        const hardFailures = challenges.filter((c) => !c.ok && !c.soft).map((c) => c.kind);
        if (hardFailures.length && revisions < MAX_REVISIONS) {
          revision = reviseCandidate(change, hardFailures, captured, obs, topo);
          if (revision) {
            revisions += 1;
            queue.unshift(revision);
            rec.push(1800, 'revised', 'challenge', 'diagnosis', 'ai', `Revised → ${revision.label}`, revision.rationale, { parent: change.id, revision }, (f) => {
              f.counters.revisions += 1;
            });
          }
        }
      }

      const gate = evaluateGates(repro, exp, challenges);
      const decision = revision ? 'superseded' : gate.decision;
      const record: CandidateRecord = {
        change,
        diff: exp.diff,
        touched: exp.touched,
        fixed: exp.fixed,
        challenges: challenges ?? [],
        rollback: exp.rollback,
        gates: gate.gates,
        decision,
        reasons: revision ? [`superseded by ${revision.label.split(' · ')[0]}: ${gate.reasons.join('; ')}`] : [...gate.reasons, ...gate.warnings.map((w) => `G7: ${w}`)],
        restored: exp.restored,
        latencyDeltaMs: exp.latencyDeltaMs,
        forbidden,
      };
      records.push(record);
      const unsafe = decision === 'rejected' && gate.gates.some((g) => ['G3', 'G4', 'G5'].includes(g.id) && g.status === 'fail');
      const label = decision === 'pass' ? 'PASS' : decision === 'pass_with_warnings' ? 'PASS WITH WARNINGS' : decision === 'superseded' ? 'SUPERSEDED' : 'REJECTED';
      rec.push(
        1200,
        'candidate_decision',
        'gate',
        'gate',
        decision === 'pass' ? 'ok' : decision === 'pass_with_warnings' || decision === 'superseded' ? 'warn' : 'fail',
        `${change.label.split(' · ')[0]} → ${label}`,
        record.reasons[0] ?? gate.gates.filter((g) => g.status === 'pass').map((g) => g.id).join(' ') + ' passed',
        { gates: gate.gates, decision, hash: change.hash },
        (f) => {
          if (unsafe) f.counters.unsafeRejected += 1;
          upsertCandidate(f, {
            ...base,
            status: decision === 'pass' ? 'pass' : decision === 'pass_with_warnings' ? 'warn' : decision === 'superseded' ? 'superseded' : 'rejected',
            note: decision === 'superseded' ? `superseded by ${revision!.label.split(' · ')[0]}` : (record.reasons[0]?.replace(/^G\d: /, '') ?? 'all gates passed'),
          });
          f.twin = { ...f.twin!, failedNodes: [], state: 'idle', caption: `${change.label.split(' · ')[0]} → ${label}` };
        },
      );
    }
  }

  const passing = records.filter((r) => r.decision === 'pass' || r.decision === 'pass_with_warnings');
  passing.sort((a, b) => Number(a.decision !== 'pass') - Number(b.decision !== 'pass') || a.touched.length - b.touched.length || a.latencyDeltaMs - b.latencyDeltaMs);
  const selected = passing[0];
  const verdict: Verdict = selected ? (selected.decision === 'pass' ? 'PASS_UNDER_DEFINED_TESTS' : 'PASS_WITH_WARNINGS') : repro.passed ? 'ESCALATE' : 'INCONCLUSIVE';

  if (selected) {
    rec.push(
      2000,
      'gate_verdict',
      'gate',
      'gate',
      verdict === 'PASS_UNDER_DEFINED_TESTS' ? 'ok' : 'warn',
      `${VERDICT_LABEL[verdict]} · ${selected.change.label}`,
      `${selected.gates.filter((g) => g.status === 'pass').length}/7 automated gates passed${selected.gates.some((g) => g.status === 'warn') ? ' with warnings' : ''}. ${records.length - 1} alternatives rejected or superseded.`,
      { verdict, selected: selected.change, gates: selected.gates },
      (f) => {
        f.verdict = verdict;
        f.selectedId = selected.change.id;
        f.twin = { ...f.twin!, probes: byId(selected.fixed.filter((p) => p.kind === 'journey')), focus: selected.touched, caption: `Selected: ${selected.change.label}`, state: 'idle' };
      },
    );
    rec.push(800, 'awaiting_approval', 'approve', 'operator', 'info', 'Awaiting human approval', `Approval binds to change ${shortHash(selected.change.hash)} and target state ${shortHash(obs.stateHash)}. Nothing has touched the demo network.`, {
      changeHash: selected.change.hash,
      targetStateHash: obs.stateHash,
    });
  } else {
    rec.push(
      2000,
      'gate_verdict',
      'gate',
      'gate',
      'fail',
      VERDICT_LABEL[verdict],
      repro.passed ? 'No candidate survived the evidence gate. TwinOps stops instead of forcing a repair.' : 'Not reproduced: the twin cannot represent this fault. TwinOps stops instead of guessing.',
      { verdict, records: records.map((r) => ({ id: r.change.id, decision: r.decision, reasons: r.reasons })) },
      (f) => {
        f.verdict = verdict;
      },
    );
    rec.push(800, 'escalated', 'approve', 'operator', 'warn', 'Escalated to on-call engineer', `Evidence bundle handed over: ${hypotheses[0].title}. No change is proposed.`, { hypothesis: hypotheses[0] });
  }

  const run: RunResult = {
    runId,
    seed: opts.seed,
    pack: opts.pack,
    versions,
    mode: PLANNER_MODE,
    topology: topo,
    observation: obs,
    guardedLogs,
    hypotheses,
    diagnostics,
    reproduction: repro,
    candidates: records,
    selected,
    verdict,
    untested: untestedConditions(topo, repro),
    events: rec.events,
    computeMs: Math.round((performance.now() - t0) * 10) / 10,
    snapshotHash: obs.stateHash,
    v6Pops: pops(topo).filter((p) => captured.b17.v6Prefixes.includes(p.v6Prefix!)).map((p) => p.id),
    writesDuringDiagnosis: demo.writes.filter((w) => w.actor !== 'harness').length,
  };
  return { run, demo, postEvents: [] };
}

export function simulateDrift(session: IncidentSession) {
  session.demo.simulateDrift();
}

export function createApproval(session: IncidentSession, operator: string, comment: string, decision: 'approve' | 'reject'): ApprovalRecord {
  const { run } = session;
  if (!run.selected) throw new Error('nothing to approve: no candidate passed the gate');
  const decidedAt = new Date().toISOString();
  const changeHash = run.selected.change.hash;
  return {
    runId: run.runId,
    candidateId: run.selected.change.id,
    changeHash,
    targetStateHash: run.snapshotHash,
    operator,
    comment,
    decision,
    decidedAt,
    token: sha256(`${run.runId}|${changeHash}|${run.snapshotHash}|${operator}|${decision}|${decidedAt}`),
  };
}

/** Lab-only apply gateway: the only write path, and only with an approval bound to hash and state. */
export function applyWithApproval(session: IncidentSession, approval: ApprovalRecord): RunEvent[] {
  const { run, demo } = session;
  const last = run.events.at(-1)!;
  const prior = session.postEvents.at(-1) ?? last;
  const rec = new Recorder(prior.frame, demo, prior.at, prior.seq);
  const selected = run.selected;
  session.approval = approval;

  const refuse = (reason: string, kind: EventKind = 'drift_detected') => {
    session.outcome = { status: 'refused', reason, postChecks: [] };
    rec.push(900, kind, 'apply', 'apply', 'fail', 'Apply refused — approval invalidated', reason, { approval, reason });
  };

  if (approval.decision === 'reject') {
    session.outcome = { status: 'rejected_by_operator', reason: approval.comment || 'operator rejected the change', postChecks: [] };
    rec.push(600, 'approval_rejected', 'approve', 'operator', 'warn', `Rejected by ${approval.operator}`, 'No change applied. The evidence bundle is retained for review.', approval);
  } else if (!selected) {
    refuse('No candidate passed the evidence gate.', 'approval_rejected');
  } else if (approval.changeHash !== selected.change.hash || approval.candidateId !== selected.change.id) {
    refuse(`Approval hash ${shortHash(approval.changeHash)} does not match tested change ${shortHash(selected.change.hash)}.`);
  } else if (approval.runId !== run.runId) {
    refuse('Approval belongs to a different run.');
  } else {
    rec.push(600, 'approval_recorded', 'approve', 'operator', 'ok', `Approved by ${approval.operator}`, `Token ${shortHash(approval.token)} bound to change ${shortHash(approval.changeHash)} and state ${shortHash(approval.targetStateHash)}.`, approval, (f) => {
      f.phase = 'approve';
    });
    const current = demo.stateHash();
    if (current !== approval.targetStateHash) {
      refuse(`Target state drifted (${shortHash(approval.targetStateHash)} → ${shortHash(current)}) since the snapshot. Re-observe and re-verify before any change.`);
    } else {
      const previous = demo.applyApproved(selected.change, approval.token);
      const after = demo.observe();
      const v6 = run.topology.journeys
        .filter((j) => run.v6Pops.includes(j.from))
        .map((j) => ({ ...demo.probe(j.id, 'v6'), kind: 'challenge' as const }));
      const postChecks = [...after.probes, ...v6];
      const failed = postChecks.filter((p) => !p.ok);
      rec.push(1400, 'applied', 'apply', 'apply', 'prod', `Applied to demo network: ${selected.change.label}`, `${selected.change.steps.map(describeStep).join(' + ')} executed once via the apply gateway.`, { change: selected.change, token: approval.token }, (f) => {
        f.phase = 'apply';
      });
      if (failed.length === 0) {
        session.outcome = { status: 'applied', reason: 'post-change checks passed', postChecks };
        rec.push(1600, 'post_check', 'apply', 'apply', 'ok', 'Post-change verification passed', `${postChecks.length} checks on the demo network: all customer journeys, negative tests and IPv6 parity succeed.`, { postChecks }, (f) => {
          f.prod = { probes: byId(after.probes.filter((p) => p.kind === 'journey')), alarmNodes: [], status: 'restored' };
        });
      } else {
        demo.restore(previous, approval.token);
        session.outcome = { status: 'rolled_back', reason: `${failed.length} post-checks failed`, postChecks };
        rec.push(1600, 'rolled_back', 'apply', 'apply', 'fail', 'Post-check failed — rolled back', failed.map((p) => `${p.id}: ${p.detail}`).join('; '), { postChecks });
      }
    }
  }
  session.postEvents.push(...rec.events);
  return rec.events;
}

export function decide(session: IncidentSession, operator: string, comment: string, decision: 'approve' | 'reject') {
  return applyWithApproval(session, createApproval(session, operator, comment, decision));
}

export function buildProofPack(session: IncidentSession) {
  const { run, approval, outcome, demo } = session;
  const failing = run.observation.probes.filter((p) => p.kind === 'journey' && !p.ok);
  return {
    incident_id: run.runId,
    generated_at: new Date().toISOString(),
    verdict: VERDICT_LABEL[run.verdict],
    scope_note: 'Verified under tested scenarios only. This is evidence from a synthetic model twin, not a guarantee of production safety.',
    mode: run.mode,
    versions: run.versions,
    seed: run.seed,
    captured_state_hash: run.snapshotHash,
    observation: {
      failing_journeys: failing.map((p) => ({ id: p.id, detail: p.detail })),
      alarms: run.observation.alarms.length,
      raw_events: run.observation.rawEventCount,
      recent_changes: run.observation.changes.filter((c) => c.minutesAgo <= 60).map((c) => `${c.id} ${c.node}: ${c.summary}`),
      quarantined_untrusted_text: run.guardedLogs.filter((l) => l.flagged).map((l) => `${l.node}: ${l.text}`),
    },
    hypotheses: run.hypotheses.map((h) => ({ rank: h.rank, title: h.title, supporting: h.supporting, contradicting: h.contradicting })),
    reproduction: {
      symptoms_matched: `${run.reproduction.matched}/${run.reproduction.total}`,
      passed: run.reproduction.passed,
      slice: run.reproduction.slice,
      mismatches: run.reproduction.mismatches,
      outside_twin_fidelity: run.reproduction.outOfScope,
    },
    experiments: run.candidates.map((c) => ({
      id: c.change.id,
      label: c.change.label,
      origin: c.change.origin,
      steps: c.change.steps.map(describeStep),
      change_hash: c.change.hash,
      restored: c.restored,
      latency_delta_ms: c.latencyDeltaMs,
      decision: c.decision,
      gates: Object.fromEntries(c.gates.map((g) => [g.id, `${g.status}: ${g.reason}`])),
      challenges: c.challenges.map((ch) => ({ challenge: ch.label, ok: ch.ok, soft: ch.soft, detail: ch.detail })),
      diff: c.diff,
    })),
    selected: run.selected
      ? { id: run.selected.change.id, label: run.selected.change.label, change_hash: run.selected.change.hash, steps: run.selected.change.steps.map(describeStep), rollback: run.selected.rollback }
      : null,
    rejected_unsafe: run.candidates.filter((c) => c.decision === 'rejected' && c.gates.some((g) => ['G3', 'G4', 'G5'].includes(g.id) && g.status === 'fail')).map((c) => c.change.label),
    production_writes_during_diagnosis: run.writesDuringDiagnosis,
    write_log: demo.writes,
    approval: approval ?? null,
    apply: outcome ?? null,
    untested_conditions: run.untested,
    event_count: run.events.length + session.postEvents.length,
  };
}

export type ProofPack = ReturnType<typeof buildProofPack>;
