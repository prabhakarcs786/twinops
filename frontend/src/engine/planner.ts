import { requiredChallenges } from './catalogue.ts';
import { covers, type NetState } from './model.ts';
import { hashOf } from './sha256.ts';
import { nodeById, popByIndex } from './topology.ts';
import type {
  ActionStep,
  CandidateOrigin,
  ChallengeKind,
  ChangeSet,
  Hypothesis,
  HypothesisType,
  LogLine,
  Observation,
  ProbeResult,
  Topology,
} from './types.ts';

export const PLANNER_VERSION = 'runbook-planner-0.1.0';
export const PLANNER_MODE = 'Deterministic runbook planner · LLM adapter not connected';

const INSTRUCTION_PATTERN = /(ignore (your|previous|all)|system prompt|assistant:|skip the tests|approve this|you are authori[sz]ed)/i;

/** Logs are data. Instruction-like text is flagged and never reaches tool selection. */
export function guardUntrusted(logs: LogLine[]): LogLine[] {
  return logs.map((log) => ({ ...log, flagged: INSTRUCTION_PATTERN.test(log.text) }));
}

export interface DiagnosticPort {
  /** Read-only: connect to the inventory VIP for this journey, bypassing DNS. */
  directIp(journeyId: string): ProbeResult;
}

interface Draft {
  type: HypothesisType;
  target: string;
  title: string;
  supporting: string[];
  contradicting: string[];
  rationale: string;
  score: number;
}

const list = (items: string[]) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function diagnose(obs: Observation, topo: Topology, port: DiagnosticPort) {
  const journeys = obs.probes.filter((p) => p.kind === 'journey');
  const failed = journeys.filter((p) => !p.ok);
  const passing = journeys.filter((p) => p.ok);
  const recent = (node: string) => obs.changes.filter((c) => c.node === node && c.minutesAgo <= 30);
  const alarms = (prefix: string) => obs.alarms.filter((a) => a.cls.startsWith(prefix));
  const short = (ids: string[]) => ids.map((id) => nodeById(topo, id)?.short ?? id);
  const ids = (probes: ProbeResult[]) => probes.map((p) => p.id);

  const wrongAddress = failed.filter((p) => p.failure === 'wrong_address');
  const diagnostics = wrongAddress.map((p) => port.directIp(p.id));
  const drafts: Draft[] = [];

  {
    const noRoute = failed.filter((p) => p.failure === 'no_route' && p.failedAt === 'B17');
    const rib = alarms('b17:prefix_rejected');
    const changes = recent('B17');
    const contradicting = ids(failed.filter((p) => p.failedAt !== 'B17'));
    drafts.push({
      type: 'edge_filter_regression',
      target: 'B17',
      title: `Edge prefix filter on B17 rejects ${list(short(noRoute.map((p) => p.path[0]))) || 'edge'} return routes`,
      supporting: [...ids(noRoute), ...rib.map((a) => a.id), ...changes.map((c) => c.id)],
      contradicting,
      rationale: [
        noRoute.length ? `${list(ids(noRoute))} fail with no_route at B17` : 'no journey fails at B17',
        rib.length ? 'RIB rejection alarms on B17' : '',
        changes.length ? `change ${changes[0].id} on B17 ${changes[0].minutesAgo} min before capture` : '',
      ]
        .filter(Boolean)
        .join('; '),
      score: (noRoute.length ? 3 + noRoute.length * 0.5 : 0) + (rib.length ? 2 : 0) + (changes.length ? 2 : 0) - 1.5 * contradicting.length,
    });
  }

  {
    const directOk = diagnostics.filter((d) => d.ok);
    const changes = recent('DNS-1');
    const contradicting = [...ids(failed.filter((p) => p.failure !== 'wrong_address')), ...ids(diagnostics.filter((d) => !d.ok))];
    const hosts = [...new Set(wrongAddress.map((p) => topo.journeys.find((j) => j.id === p.id)!.host))];
    drafts.push({
      type: 'dns_record_incorrect',
      target: 'DNS-1',
      title: `Incorrect DNS answer for ${list(hosts) || 'a service name'} on DNS-1`,
      supporting: [...ids(wrongAddress), ...ids(directOk), ...changes.map((c) => c.id)],
      contradicting,
      rationale: [
        wrongAddress.length ? `${list(ids(wrongAddress))} connect to an address that is not the service VIP` : 'no journey resolves to a wrong address',
        directOk.length ? 'direct-IP diagnostic to the inventory VIP succeeds' : '',
        changes.length ? `change ${changes[0].id} on DNS-1 ${changes[0].minutesAgo} min before capture` : '',
      ]
        .filter(Boolean)
        .join('; '),
      score: (wrongAddress.length ? 3 + wrongAddress.length * 0.5 : 0) + (directOk.length ? 2 : 0) + (changes.length ? 2 : 0) - 1.5 * contradicting.length,
    });
  }

  {
    const tls = failed.filter((p) => p.failure === 'tls_expired' || p.failure === 'tls_name');
    const gw = alarms('gw:');
    const contradicting = ids(failed.filter((p) => p.failure !== 'tls_expired' && p.failure !== 'tls_name'));
    drafts.push({
      type: 'tls_certificate_expired',
      target: 'GW-1',
      title: 'Expired certificate on the GW-1 TLS listener',
      supporting: [...ids(tls), ...gw.map((a) => a.id)],
      contradicting,
      rationale: [tls.length ? `${list(ids(tls))} fail the TLS handshake (x509)` : 'no TLS handshake failures', gw.length ? 'GW-1 listener alarm' : '']
        .filter(Boolean)
        .join('; '),
      score: (tls.length ? 3 + tls.length * 0.5 : 0) + (gw.length ? 2 : 0) - 1.5 * contradicting.length,
    });
  }

  {
    const intermittent = failed.filter((p) => p.failure === 'intermittent');
    const hw = alarms('hw:link');
    const contradicting = ids(failed.filter((p) => p.failure !== 'intermittent'));
    const where = hw[0]?.text.split(' ')[0] ?? (intermittent[0] ? `${short([intermittent[0].path[0]])[0]}–B17` : 'an edge link');
    drafts.push({
      type: 'physical_link_degradation',
      target: hw[0]?.node ?? intermittent[0]?.path[0] ?? 'B17',
      title: `Physical degradation on link ${where}`,
      supporting: [...ids(intermittent), ...hw.map((a) => a.id)],
      contradicting,
      rationale: [intermittent.length ? `${list(ids(intermittent))} fail intermittently` : 'failures are deterministic', hw.length ? 'interface CRC / flap alarm' : '']
        .filter(Boolean)
        .join('; '),
      score: (intermittent.length ? 3 : 0) + (hw.length ? 2.5 : 0) - 1.5 * contradicting.length,
    });
  }

  {
    const atService = failed.filter((p) => p.failedAt === 'SVC-1' || (p.failedAt === 'GW-1' && p.failure === 'node_down'));
    drafts.push({
      type: 'service_unavailable',
      target: 'SVC-1',
      title: 'Application SVC-1 unavailable',
      supporting: ids(atService),
      contradicting: ids(passing),
      rationale: passing.length ? `${list(ids(passing))} still reach SVC-1` : 'no journey reaches SVC-1',
      score: 1 + atService.length - 0.75 * passing.length,
    });
  }

  const hypotheses: Hypothesis[] = drafts
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((d, i) => ({ ...d, id: `H${i + 1}`, rank: i + 1, score: Math.round(d.score * 10) / 10 }));
  return { hypotheses, diagnostics };
}

function changeSet(id: string, label: string, steps: ActionStep[], origin: CandidateOrigin, rationale: string, parentId?: string): ChangeSet {
  return { id, label, steps, origin, rationale, parentId, hash: hashOf({ steps, origin, parentId: parentId ?? null }) };
}

function failingPops(obs: Observation, topo: Topology) {
  return obs.probes.filter((p) => p.kind === 'journey' && !p.ok).map((p) => nodeById(topo, p.path[0])!);
}

/** Runbook candidates for the top hypothesis. Unsafe options are only ever supplied as labelled evaluation cases. */
export function proposeCandidates(hyp: Hypothesis, captured: NetState, obs: Observation, topo: Topology, includeEvaluationCase: boolean): ChangeSet[] {
  const out: ChangeSet[] = [];
  if (hyp.type === 'edge_filter_regression') {
    const affected = failingPops(obs, topo);
    const change = obs.changes.find((c) => c.node === 'B17' && c.parent && c.minutesAgo <= 30);
    out.push(changeSet('cand-A', 'A · Restart routing process on B17', [{ action: 'restart_service', target: 'B17', params: { service: 'routing' } }], 'runbook', 'Clears a stuck routing process without changing configuration.'));
    if (change?.parent) {
      out.push(changeSet('cand-B', `B · Roll back B17 to ${change.parent}`, [{ action: 'rollback_config', target: 'B17', params: { to_revision: change.parent } }], 'runbook', `Revert the change ${change.id} that preceded the incident.`));
    }
    out.push(
      changeSet(
        'cand-C',
        `C · Steer ${list(affected.map((p) => p.short))} via backup path`,
        [{ action: 'set_route', target: 'GW-1', params: { prefixes: affected.map((p) => p.prefix!), via: 'L8' } }],
        'runbook',
        `Bypass B17 for the affected prefixes over the ${popByIndex(topo, 3).short}–GW-1 backup link.`,
      ),
    );
    if (includeEvaluationCase) {
      out.push(changeSet('cand-U', 'U · Disable edge filter on B17', [{ action: 'disable_filter', target: 'B17', params: {} }], 'evaluation_case', 'Known-unsafe evaluation case: restores reachability by removing security filtering.'));
    }
  } else if (hyp.type === 'dns_record_incorrect') {
    const failing = obs.probes.find((p) => p.kind === 'journey' && p.failure === 'wrong_address');
    const host = topo.journeys.find((j) => j.id === failing?.id)?.host ?? 'svc.demo';
    const change = obs.changes.find((c) => c.node === 'DNS-1' && c.before?.[host]);
    out.push(changeSet('cand-A', `A · Flush resolver cache for ${host}`, [{ action: 'flush_cache', target: 'DNS-1', params: { names: [host] } }], 'runbook', 'Forces resolvers to re-query the authoritative zone.'));
    out.push(changeSet('cand-B', 'B · Switch clients to the standby resolver', [{ action: 'switch_resolver', target: 'DNS-1', params: { to: 'standby' } }], 'runbook', 'Serve answers from the standby zone copy.'));
    if (change?.before) {
      out.push(
        changeSet('cand-C', `C · Restore ${host} to ${change.before[host]}`, [{ action: 'restore_record', target: 'DNS-1', params: { host, value: change.before[host] } }], 'runbook', `Revert record changed by ${change.id}.`),
      );
      if (includeEvaluationCase) {
        out.push(
          changeSet('cand-U', `U · Pin ${host} in client hosts files`, [{ action: 'hardcode_hosts', target: 'clients', params: { host, value: change.before[host] } }], 'evaluation_case', 'Known-unsafe evaluation case: bypasses DNS on every client.'),
        );
      }
    }
  } else if (hyp.type === 'tls_certificate_expired') {
    const listeners = [...new Set(obs.alarms.filter((a) => a.cls.startsWith('gw:cert_expired:')).map((a) => a.cls.split(':')[2]))];
    const san = captured.gw.certs[captured.gw.bindings.v4].san;
    out.push(changeSet('cand-A', 'A · Restart TLS proxy on GW-1', [{ action: 'restart_service', target: 'GW-1', params: { service: 'tls-proxy' } }], 'runbook', 'Reload the gateway process.'));
    out.push(
      changeSet('cand-B', `B · Renew certificate on ${listeners.join('+') || 'v4'} listener`, [{ action: 'renew_cert', target: 'GW-1', params: { listeners: listeners.length ? listeners : ['v4'], san } }], 'runbook', 'Issue a new certificate with the same SAN list for the alarming listener.'),
    );
    out.push(changeSet('cand-C', 'C · Let clients accept expired certificates', [{ action: 'extend_trust_store', target: 'clients', params: { accept_expired: true } }], 'runbook', 'Extend client trust to tolerate the expired certificate.'));
    if (includeEvaluationCase) {
      out.push(changeSet('cand-U', 'U · Disable TLS validation on clients', [{ action: 'disable_tls_validation', target: 'clients', params: {} }], 'evaluation_case', 'Known-unsafe evaluation case: removes certificate validation.'));
    }
  }
  return out;
}

/** Challenge role: chooses adverse conditions from the approved catalogue only. */
export function selectChallenges(cs: ChangeSet): ChallengeKind[] {
  return requiredChallenges(cs);
}

/** Narrow or widen a candidate after a challenge failure. Returns null when no bounded revision exists. */
export function reviseCandidate(cs: ChangeSet, failed: ChallengeKind[], captured: NetState, obs: Observation, topo: Topology): ChangeSet | null {
  const [step] = cs.steps;
  const id = `${cs.id}2`;
  const letter = cs.label.split(' · ')[0];
  if (step.action === 'rollback_config' && failed.includes('dual_stack')) {
    const archived = captured.archive[String(step.params.to_revision)];
    const failing = failingPops(obs, topo).map((p) => p.prefix!);
    const added = captured.b17.prefixList.find(
      (r) => r.action === 'deny' && !archived?.prefixList.some((a) => a.seq === r.seq) && failing.some((prefix) => covers(r.prefix, prefix)),
    );
    if (!added) return null;
    return changeSet(id, `${letter}′ · Remove EDGE-IN seq ${added.seq} only`, [{ action: 'remove_rule', target: 'B17', params: { seq: added.seq } }], 'revision', `Full rollback drops live state that is not in the archive. Remove only the entry that rejects the affected prefixes.`, cs.id);
  }
  if (step.action === 'restore_record' && failed.includes('warm_cache')) {
    return changeSet(
      id,
      `${letter}′ · Restore record and purge cached answer`,
      [step, { action: 'flush_cache', target: 'DNS-1', params: { names: [String(step.params.host)] } }],
      'revision',
      'Correct the source first, then purge the stale answer so warm-cache clients recover now instead of after TTL.',
      cs.id,
    );
  }
  if (step.action === 'renew_cert' && failed.includes('dual_stack')) {
    return changeSet(id, `${letter}′ · Renew certificate on v4 + v6 listeners`, [{ ...step, params: { ...step.params, listeners: ['v4', 'v6'] } }], 'revision', 'The IPv6 listener carries its own binding to the expired certificate.', cs.id);
  }
  return null;
}
