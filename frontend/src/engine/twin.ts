import { applyChangeSet, diffStates, forbiddenReasons, MAX_BLAST_RADIUS, sessionImpact, touchedNodes, validateChangeSet } from './catalogue.ts';
import { clone, fixedSuite, modelledAlarms, probeJourney, type NetState } from './model.ts';
import { hashOf } from './sha256.ts';
import { LATENCY_BUDGET_MS, nodeById, popByIndex, pops } from './topology.ts';
import type {
  ChallengeKind,
  ChallengeResult,
  ChangeSet,
  DiffLine,
  GateCheck,
  Journey,
  Observation,
  ProbeResult,
  Reproduction,
  Topology,
} from './types.ts';

export interface TwinContext {
  topo: Topology;
  obs: Observation;
  captured: NetState;
  slice: string[];
  journeys: Journey[];
  affectedIds: string[];
}

export function selectSlice(obs: Observation, topo: Topology) {
  const failing = obs.probes.filter((p) => p.kind === 'journey' && !p.ok).map((p) => topo.journeys.find((j) => j.id === p.id)!);
  const affected = [...new Set(failing.map((j) => j.from))];
  let representatives = affected;
  if (affected.length > 2) {
    const byHost = new Map<string, string>();
    for (const j of failing) if (!byHost.has(j.host)) byHost.set(j.host, j.from);
    representatives = [...byHost.values()];
  }
  const unaffected = pops(topo).filter((p) => !affected.includes(p.id));
  const adjacent = unaffected.find((p) => topo.links.some((l) => (l.a === p.id && affected.includes(l.b)) || (l.b === p.id && affected.includes(l.a))));
  const control = adjacent ? [adjacent.id] : unaffected[0] ? [unaffected[0].id] : [];
  const slice = [...representatives, ...control, 'B17', 'DNS-1', 'GW-1', 'SVC-1'];
  return { slice, affected, representatives, control };
}

export function createContext(obs: Observation, topo: Topology, captured: NetState): TwinContext {
  const { slice } = selectSlice(obs, topo);
  const journeys = topo.journeys.filter((j) => slice.includes(j.from));
  const affectedIds = obs.probes.filter((p) => p.kind === 'journey' && !p.ok && journeys.some((j) => j.id === p.id)).map((p) => p.id);
  return { topo, obs, captured, slice, journeys, affectedIds };
}

export function reproduce(ctx: TwinContext): Reproduction {
  const { captured, topo, obs, journeys, slice } = ctx;
  const twinProbes = fixedSuite(captured, topo, journeys);
  const relevant = obs.probes.filter((p) => (p.kind === 'journey' ? journeys.some((j) => j.id === p.id) : true));
  const mismatches: string[] = [];
  let matched = 0;
  let total = 0;
  for (const prod of relevant) {
    const twin = twinProbes.find((t) => t.id === prod.id);
    total += 1;
    const same = twin && twin.ok === prod.ok && (prod.ok || twin.failure === prod.failure);
    if (same) matched += 1;
    else mismatches.push(`${prod.id}: production ${prod.ok ? 'ok' : prod.failure}, twin ${twin ? (twin.ok ? 'ok' : twin.failure) : 'missing'}`);
  }
  const twinAlarmClasses = new Set(modelledAlarms(captured, topo, twinProbes).map((a) => a.cls));
  for (const alarm of obs.alarms.filter((a) => a.modelled && slice.includes(a.node))) {
    total += 1;
    if (twinAlarmClasses.has(alarm.cls)) matched += 1;
    else mismatches.push(`${alarm.id}: alarm not reproduced`);
  }
  const affectedReproduced = ctx.affectedIds.every((id) => {
    const prod = obs.probes.find((p) => p.id === id)!;
    const twin = twinProbes.find((t) => t.id === id);
    return twin && !twin.ok && twin.failure === prod.failure;
  });
  return {
    matched,
    total,
    affectedReproduced,
    passed: affectedReproduced && total > 0 && matched / total >= 0.9,
    mismatches,
    outOfScope: obs.alarms.filter((a) => !a.modelled).map((a) => `${a.node}: ${a.text}`),
    slice,
    twinProbes,
  };
}

export interface Experiment {
  change: ChangeSet;
  errors: string[];
  after: NetState;
  diff: DiffLine[];
  touched: string[];
  fixed: ProbeResult[];
  restored: boolean;
  regressions: ProbeResult[];
  /** Pre-change latency of each regressed probe, so a latency regression is reported as such. */
  regressionBaselines: Record<string, number | undefined>;
  latencyDeltaMs: number;
  forbidden: string[];
  rollback: { rehearsed: boolean; matches: boolean; restoredHash: string };
}

/** A probe that still succeeds but got slower is a latency regression; say so instead of quoting its success detail. */
function regressionText(p: ProbeResult, baselineMs: number | undefined): string {
  return p.ok && baselineMs !== undefined ? `${p.id} latency regression: ${p.latencyMs} ms vs ${baselineMs} ms before the change` : `${p.id} ${p.detail}`;
}

export function runExperiment(ctx: TwinContext, change: ChangeSet): Experiment {
  const { captured, topo, journeys, affectedIds, obs } = ctx;
  const errors = validateChangeSet(change);
  const after = errors.length ? clone(captured) : applyChangeSet(captured, change, topo);
  const fixed = fixedSuite(after, topo, journeys, captured);
  const restored = errors.length === 0 && affectedIds.every((id) => fixed.find((p) => p.id === id)?.ok);
  const regressions = fixed.filter((p) => {
    if (affectedIds.includes(p.id)) return false;
    if (!p.ok) return true;
    const before = ctx.obs.probes.find((o) => o.id === p.id);
    return p.kind === 'journey' && before?.latencyMs !== undefined && (p.latencyMs ?? 0) - before.latencyMs > 5;
  });
  const regressionBaselines = Object.fromEntries(regressions.map((p) => [p.id, ctx.obs.probes.find((o) => o.id === p.id)?.latencyMs]));
  const deltas = affectedIds.map((id) => (fixed.find((p) => p.id === id)?.latencyMs ?? 0) - (obs.baselines[id] ?? 0));
  const latencyDeltaMs = restored && deltas.length ? Math.round(Math.max(...deltas) * 10) / 10 : 0;

  // Rollback rehearsal: restore every touched section from the snapshot and compare hashes.
  const rolled = clone(after);
  const diff = diffStates(captured, after);
  for (const section of ['b17', 'dns', 'clients', 'gw', 'notes'] as const) {
    if (diff.some((d) => d.path.startsWith(`${section}.`))) (rolled as unknown as Record<string, unknown>)[section] = clone(captured[section]);
  }
  const restoredHash = hashOf(rolled);
  return {
    change,
    errors,
    after,
    diff,
    touched: errors.length ? [] : touchedNodes(change, topo),
    fixed,
    restored,
    regressions,
    regressionBaselines,
    latencyDeltaMs,
    forbidden: errors.length ? [] : forbiddenReasons(change),
    rollback: { rehearsed: errors.length === 0, matches: restoredHash === hashOf(captured), restoredHash },
  };
}

const CHALLENGE_LABEL: Record<ChallengeKind, string> = {
  dual_stack: 'IPv6 / dual-stack parity',
  secondary_failure: 'Secondary node failure',
  surge_x3: 'Traffic surge ×3',
  warm_cache: 'Warm-cache clients (TTL 3600 s)',
  session_continuity: 'Session continuity',
};

export function runChallenge(ctx: TwinContext, exp: Experiment, kind: ChallengeKind): ChallengeResult {
  const { topo, journeys, captured, slice } = ctx;
  const id = `CH-${kind}`;
  const label = CHALLENGE_LABEL[kind];
  const result = (ok: boolean, detail: string, probes: ProbeResult[], soft = false): ChallengeResult => ({ id, kind, label, ok, soft, detail, probes });

  if (kind === 'dual_stack') {
    const v6 = journeys.filter((j) => captured.b17.v6Prefixes.includes(nodeById(topo, j.from)!.v6Prefix!));
    const probes = v6.map((j) => probeJourney(exp.after, topo, j, { family: 'v6', kind: 'challenge' }));
    const failed = probes.filter((p) => !p.ok);
    return result(failed.length === 0, failed.length ? failed.map((p) => `${p.label}: ${p.detail}`).join('; ') : `${probes.length} IPv6 journeys succeed`, probes);
  }
  if (kind === 'secondary_failure') {
    const transit = exp.fixed.flatMap((p) => p.path.slice(1)).find((n) => pops(topo).some((p) => p.id === n));
    const exit = popByIndex(topo, 3).id;
    const target = transit ?? (slice.includes(exit) ? exit : slice.find((n) => pops(topo).some((p) => p.id === n))!);
    const state = { ...clone(exp.after), failedNodes: [target] };
    const probes = journeys.filter((j) => j.from !== target).map((j) => probeJourney(state, topo, j, { kind: 'challenge', id: `${j.id}-sf` }));
    const failed = probes.filter((p) => !p.ok);
    return result(
      failed.length === 0,
      failed.length ? `with ${target} down: ${failed.map((p) => `${p.label} — ${p.detail}`).join('; ')}` : `with ${target} down, all remaining journeys succeed`,
      probes,
    );
  }
  if (kind === 'surge_x3') {
    const state = { ...clone(exp.after), load: 3 };
    const probes = journeys.map((j) => probeJourney(state, topo, j, { kind: 'challenge', id: `${j.id}-surge` }));
    const failed = probes.filter((p) => !p.ok);
    const worst = Math.max(...probes.map((p) => p.latencyMs ?? 0));
    return result(failed.length === 0, failed.length ? failed.map((p) => `${p.label}: ${p.detail}`).join('; ') : `worst latency ${worst} ms under ×3 load`, probes);
  }
  if (kind === 'warm_cache') {
    const probes = ctx.affectedIds.map((id) => {
      const j = topo.journeys.find((x) => x.id === id)!;
      return probeJourney(exp.after, topo, j, { warmCache: true, kind: 'challenge', id: `${j.id}-warm` });
    });
    const failed = probes.filter((p) => !p.ok);
    return result(failed.length === 0, failed.length ? `clients with cached answers still fail: ${failed[0].detail}` : 'clients with warm caches recover immediately', probes);
  }
  const impact = sessionImpact(exp.change);
  if (impact === 'none') return result(true, 'no session-affecting process change', []);
  return result(false, impact === 'reset' ? 'process restart resets every active session on the target' : 'graceful reload drains long-lived sessions (clients re-handshake)', [], true);
}

export function evaluateGates(repro: Reproduction, exp: Experiment, challenges: ChallengeResult[] | null) {
  const gates: GateCheck[] = [];
  const reasons: string[] = [];
  const add = (gate: GateCheck) => {
    gates.push(gate);
    if (gate.status === 'fail') reasons.push(`${gate.id}: ${gate.reason}`);
  };

  add(repro.passed ? { id: 'G1', status: 'pass', reason: `${repro.matched}/${repro.total} symptoms reproduced in twin` } : { id: 'G1', status: 'fail', reason: 'fault not reproduced — no fix can be trusted' });

  const stillFailing = exp.fixed.filter((p) => !p.ok && !exp.regressions.includes(p) && p.kind === 'journey');
  add(
    exp.restored
      ? { id: 'G2', status: 'pass', reason: 'every affected journey succeeds in the twin' }
      : { id: 'G2', status: 'fail', reason: exp.errors.length ? 'not executed — malformed change set' : `${stillFailing.map((p) => p.id).join(', ')} still failing: ${stillFailing[0]?.detail ?? ''}` },
  );

  add(
    exp.regressions.length === 0
      ? { id: 'G3', status: 'pass', reason: 'unaffected journeys, negative tests and positive control unchanged' }
      : { id: 'G3', status: 'fail', reason: exp.regressions.map((p) => regressionText(p, exp.regressionBaselines[p.id])).join('; ') },
  );

  if (!challenges) add({ id: 'G4', status: 'skip', reason: 'not attacked — an earlier gate already failed' });
  else {
    const hard = challenges.filter((c) => !c.ok && !c.soft);
    add(hard.length ? { id: 'G4', status: 'fail', reason: hard.map((c) => `${c.label}: ${c.detail}`).join('; ') } : { id: 'G4', status: 'pass', reason: `survived ${challenges.length} challenges` });
  }

  if (exp.errors.length) add({ id: 'G5', status: 'fail', reason: `schema validation: ${exp.errors.join('; ')}` });
  else if (exp.forbidden.length) add({ id: 'G5', status: 'fail', reason: exp.forbidden.join(' ') });
  else if (exp.touched.length > MAX_BLAST_RADIUS) add({ id: 'G5', status: 'fail', reason: `blast radius ${exp.touched.length} nodes exceeds ${MAX_BLAST_RADIUS}` });
  else add({ id: 'G5', status: 'pass', reason: `allowed action · blast radius ${exp.touched.length} node${exp.touched.length === 1 ? '' : 's'}` });

  add(
    exp.rollback.rehearsed && exp.rollback.matches
      ? { id: 'G6', status: 'pass', reason: 'rollback rehearsed in twin — state hash restored' }
      : { id: 'G6', status: 'fail', reason: exp.rollback.rehearsed ? 'rollback did not restore the captured state' : 'rollback not rehearsed' },
  );

  const warnings = [
    exp.latencyDeltaMs > LATENCY_BUDGET_MS ? `+${exp.latencyDeltaMs} ms latency over baseline (budget ${LATENCY_BUDGET_MS} ms)` : '',
    ...(challenges ?? []).filter((c) => !c.ok && c.soft).map((c) => `${c.label}: ${c.detail}`),
  ].filter(Boolean);
  gates.push(warnings.length ? { id: 'G7', status: 'warn', reason: warnings.join('; ') } : { id: 'G7', status: 'pass', reason: 'within latency budget, no session impact' });
  gates.push({ id: 'G8', status: 'pending', reason: 'requires a human approval bound to this change hash' });

  const failed = gates.some((g) => g.status === 'fail');
  const decision = failed ? 'rejected' : warnings.length ? 'pass_with_warnings' : 'pass';
  return { gates, decision: decision as 'rejected' | 'pass' | 'pass_with_warnings', reasons, warnings };
}
