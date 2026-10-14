import { findLink, MGMT_PREFIX, nodeById, pathBetween, popByIndex, pops, SERVICE_IPS, SLO_LATENCY_MS } from './topology.ts';
import type { Alarm, Journey, ProbeKind, ProbeResult, Topology } from './types.ts';

export interface PrefixRule {
  seq: number;
  action: 'deny' | 'permit';
  prefix: string;
  note: string;
}

export interface B17Config {
  revision: string;
  filterEnabled: boolean;
  prefixList: PrefixRule[];
  v6Prefixes: string[];
}

export interface Cert {
  serial: string;
  notAfter: string;
  san: string[];
}

export interface NetState {
  b17: B17Config & { steered: string[]; routingUp: boolean };
  archive: Record<string, B17Config>;
  dns: {
    active: 'primary' | 'standby';
    primary: Record<string, string>;
    standby: Record<string, string>;
    cache: Record<string, string>;
    serial: number;
  };
  clients: { hosts: Record<string, string>; validateTls: boolean; acceptExpired: boolean };
  gw: { bindings: { v4: string; v6: string }; certs: Record<string, Cert>; up: boolean };
  /** Physical layer is not part of the twin's supported state. */
  physical: { flappingLink: string | null };
  failedNodes: string[];
  load: number;
  now: string;
  mgmt: { adminServiceUp: boolean };
  notes: Record<string, string>;
}

export const SIM_NOW = '2026-11-17T09:30:00.000Z';
const MINUTE = 60_000;
export const addMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

export const clone = <T>(value: T): T => structuredClone(value);

export function healthyState(topo: Topology): NetState {
  const [p0, p1, p2, p3] = [0, 1, 2, 3].map((i) => popByIndex(topo, i as 0 | 1 | 2 | 3));
  const archived: B17Config = {
    revision: 'r-2041',
    filterEnabled: true,
    prefixList: [
      { seq: 10, action: 'deny', prefix: MGMT_PREFIX, note: 'management network is never advertised to the edge' },
      { seq: 100, action: 'permit', prefix: '10.0.0.0/8', note: 'edge customer ranges' },
    ],
    v6Prefixes: [p0.v6Prefix!, p1.v6Prefix!, p3.v6Prefix!],
  };
  return {
    b17: {
      ...clone(archived),
      revision: 'r-2041+h-77',
      // h-77 was a manual hotfix: live on the router, never written to the config archive.
      v6Prefixes: [p0, p1, p2, p3, ...pops(topo).filter((p) => ![p0.id, p1.id, p2.id, p3.id].includes(p.id))].map((p) => p.v6Prefix!),
      steered: [],
      routingUp: true,
    },
    archive: { 'r-2041': archived },
    dns: {
      active: 'primary',
      primary: { ...SERVICE_IPS },
      standby: { 'svc.demo': SERVICE_IPS['svc.demo'], 'api.demo': '10.40.0.7' },
      cache: { ...SERVICE_IPS },
      serial: 2026111701,
    },
    clients: { hosts: {}, validateTls: true, acceptExpired: false },
    gw: {
      bindings: { v4: 'c-5a1', v6: 'c-5a1' },
      certs: { 'c-5a1': { serial: 'c-5a1', notAfter: addMinutes(SIM_NOW, 30 * 24 * 60), san: ['svc.demo', 'api.demo'] } },
      up: true,
    },
    physical: { flappingLink: null },
    failedNodes: [],
    load: 1,
    now: SIM_NOW,
    mgmt: { adminServiceUp: true },
    notes: { 'B17.description': 'core-b17 edge aggregation' },
  };
}

/** What the observation service can capture; the physical layer is outside supported fidelity. */
export function captureSupported(state: NetState): NetState {
  const captured = clone(state);
  captured.physical = { flappingLink: null };
  return captured;
}

function parseV4(prefix: string) {
  const [ip, len] = prefix.split('/');
  const n = ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
  return { n, len: Number(len) };
}

export function covers(rulePrefix: string, prefix: string) {
  const r = parseV4(rulePrefix);
  const p = parseV4(prefix);
  if (p.len < r.len) return false;
  const mask = r.len === 0 ? 0 : (~0 << (32 - r.len)) >>> 0;
  return (p.n & mask) >>> 0 === (r.n & mask) >>> 0;
}

export function filterDecision(cfg: B17Config, prefix: string): { action: 'permit' | 'deny'; rule?: PrefixRule } {
  if (!cfg.filterEnabled) return { action: 'permit' };
  const ordered = [...cfg.prefixList].sort((a, b) => a.seq - b.seq);
  for (const rule of ordered) if (covers(rule.prefix, prefix)) return { action: rule.action, rule };
  return { action: 'deny' };
}

function backupPath(state: NetState, topo: Topology, from: string): string[] | null {
  const exit = popByIndex(topo, 3).id;
  const popIds = new Set(pops(topo).map((p) => p.id));
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === exit) break;
    for (const link of topo.links) {
      const next = link.a === cur ? link.b : link.b === cur ? link.a : null;
      if (!next || !popIds.has(next) || prev.has(next) || state.failedNodes.includes(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  if (!prev.has(exit)) return null;
  const path: string[] = [];
  for (let n: string | null = exit; n; n = prev.get(n) ?? null) path.unshift(n);
  return [...path, 'GW-1', 'SVC-1'];
}

export function effectiveAnswer(state: NetState, host: string, warmCache = false): string | undefined {
  if (state.clients.hosts[host]) return state.clients.hosts[host];
  if (warmCache && state.dns.cache[host]) return state.dns.cache[host];
  if (state.failedNodes.includes('DNS-1') && state.dns.active === 'primary') return undefined;
  return (state.dns.active === 'primary' ? state.dns.primary : state.dns.standby)[host];
}

export interface ProbeOptions {
  family?: 'v4' | 'v6';
  warmCache?: boolean;
  sample?: number;
  kind?: ProbeKind;
  id?: string;
  label?: string;
}

export function probeJourney(state: NetState, topo: Topology, journey: Journey, opts: ProbeOptions = {}): ProbeResult {
  const pop = nodeById(topo, journey.from)!;
  const family = opts.family ?? 'v4';
  const base = {
    id: opts.id ?? (family === 'v6' ? `${journey.id}-v6` : journey.id),
    kind: opts.kind ?? ('journey' as ProbeKind),
    label: opts.label ?? (family === 'v6' ? `${pop.short} IPv6 → ${journey.host}` : journey.label),
  };
  const fail = (path: string[], failedAt: string, failure: ProbeResult['failure'], detail: string): ProbeResult => ({
    ...base,
    ok: false,
    path,
    failedAt,
    failure,
    detail,
  });

  if (state.failedNodes.includes(pop.id)) return fail([pop.id], pop.id, 'node_down', `${pop.short} is down (injected condition)`);

  if (state.physical.flappingLink) {
    const link = topo.links.find((l) => l.id === state.physical.flappingLink);
    if (link && (link.a === pop.id || link.b === pop.id) && [1, 3].includes(opts.sample ?? 0)) {
      return fail([pop.id, 'B17'], 'B17', 'intermittent', `packets lost on ${link.a}–${link.b}`);
    }
  }

  const ip = effectiveAnswer(state, journey.host, opts.warmCache);
  if (!ip) return fail([pop.id, 'B17', 'DNS-1'], 'DNS-1', 'node_down', `SERVFAIL resolving ${journey.host}`);

  let path: string[];
  if (family === 'v4' && state.b17.steered.includes(pop.prefix!)) {
    const backup = backupPath(state, topo, pop.id);
    if (!backup) return fail([pop.id], pop.id, 'no_route', 'backup path unavailable');
    path = backup;
  } else {
    if (!state.b17.routingUp) return fail([pop.id, 'B17'], 'B17', 'no_route', 'routing process restarting on B17');
    if (family === 'v4') {
      const decision = filterDecision(state.b17, pop.prefix!);
      if (decision.action === 'deny') {
        return fail(
          [pop.id, 'B17'],
          'B17',
          'no_route',
          `${pop.prefix} rejected by EDGE-IN ${decision.rule ? `seq ${decision.rule.seq}` : 'implicit deny'} — no return route`,
        );
      }
    } else if (!state.b17.v6Prefixes.includes(pop.v6Prefix!)) {
      return fail([pop.id, 'B17'], 'B17', 'no_route', `no route for ${pop.v6Prefix}`);
    }
    const segments = [[pop.id, 'B17'], ['B17', 'GW-1'], ['GW-1', 'SVC-1']].map(([a, b]) => pathBetween(topo, a, b, state.failedNodes));
    if (segments.some((segment) => !segment.length)) return fail([pop.id], pop.id, 'no_route', 'required service path unavailable');
    path = [...segments[0], ...segments[1].slice(1), ...segments[2].slice(1)];
  }

  for (let i = 1; i < path.length; i++) {
    if (state.failedNodes.includes(path[i])) return fail(path.slice(0, i + 1), path[i], 'node_down', `${path[i]} is down (injected condition)`);
  }

  const toGateway = path.slice(0, path.indexOf('GW-1') + 1);
  if (ip !== SERVICE_IPS[journey.host]) {
    return fail(toGateway, 'GW-1', 'wrong_address', `${journey.host} → ${ip}: connection refused (service VIP is not at that address)`);
  }
  if (!state.gw.up) return fail(toGateway, 'GW-1', 'node_down', 'gateway restarting');

  const serial = state.gw.bindings[family];
  const cert = state.gw.certs[serial];
  if (state.clients.validateTls) {
    const expiredBy = (Date.parse(state.now) - Date.parse(cert.notAfter)) / MINUTE;
    if (expiredBy > 0 && !state.clients.acceptExpired) {
      return fail(toGateway, 'GW-1', 'tls_expired', `x509: certificate ${serial} expired ${Math.round(expiredBy)} min ago (${family} listener)`);
    }
    if (!cert.san.includes(journey.host)) {
      return fail(toGateway, 'GW-1', 'tls_name', `x509: certificate ${serial} is not valid for ${journey.host}`);
    }
  }

  let latency = 2;
  for (let i = 0; i < path.length - 1; i++) {
    const link = findLink(topo, path[i], path[i + 1])!;
    const factor = state.load > 1 ? 1 + (state.load - 1) * (link.backup ? 0.6 : 0.075) : 1;
    latency += link.latencyMs * factor;
  }
  latency = Math.round(latency * 10) / 10;
  if (latency > SLO_LATENCY_MS) {
    return { ...base, ok: false, path, failedAt: 'SVC-1', failure: 'slo_breach', latencyMs: latency, detail: `${latency} ms exceeds ${SLO_LATENCY_MS} ms SLO` };
  }
  return { ...base, ok: true, path, latencyMs: latency, detail: `HTTP 200 in ${latency} ms via ${path.join(' → ')}` };
}

/** Five samples per journey: mixed outcomes are reported as intermittent. */
export function sampleJourney(state: NetState, topo: Topology, journey: Journey, opts: ProbeOptions = {}): ProbeResult {
  const samples = [0, 1, 2, 3, 4].map((sample) => probeJourney(state, topo, journey, { ...opts, sample }));
  const failed = samples.filter((s) => !s.ok);
  if (failed.length === 0) return samples[0];
  if (failed.length === samples.length) return failed[0];
  return {
    ...failed[0],
    failure: 'intermittent',
    detail: `${failed.length} of ${samples.length} samples failed — ${failed[0].detail}`,
  };
}

export function negativeProbes(state: NetState, topo: Topology, baseline?: NetState): ProbeResult[] {
  const edge = popByIndex(topo, 0).id;
  const mgmt = filterDecision(state.b17, MGMT_PREFIX);
  const exposed = mgmt.action !== 'deny';
  const validation = state.clients.validateTls && !state.clients.acceptExpired;
  const changed: string[] = [];
  if (baseline) {
    for (const host of Object.keys(SERVICE_IPS)) {
      const before = effectiveAnswer(baseline, host);
      if (before !== SERVICE_IPS[host]) continue;
      const after = effectiveAnswer(state, host);
      if (after !== before) changed.push(`${host}: ${before} → ${after ?? 'no answer'}`);
    }
  }
  const probes: ProbeResult[] = [
    {
      id: 'NEG-1',
      kind: 'negative',
      label: 'Untrusted edge → admin port stays blocked',
      ok: !exposed,
      path: [edge, 'B17'],
      failedAt: exposed ? 'B17' : undefined,
      failure: exposed ? 'exposed' : undefined,
      detail: exposed
        ? `${MGMT_PREFIX}:22 reachable from the untrusted edge — management prefix leaked`
        : `blocked by EDGE-IN seq ${mgmt.rule?.seq ?? 'implicit'}`,
    },
    {
      id: 'NEG-2',
      kind: 'negative',
      label: 'Clients reject an expired test certificate',
      ok: validation,
      path: [edge, 'GW-1'],
      failedAt: validation ? undefined : 'GW-1',
      failure: validation ? undefined : 'validation_off',
      detail: validation ? 'handshake refused as expected' : 'expired test certificate was ACCEPTED by clients',
    },
    {
      id: 'CTRL-1',
      kind: 'control',
      label: 'Positive control: admin service exists for trusted operators',
      ok: state.mgmt.adminServiceUp,
      path: ['B17'],
      failure: state.mgmt.adminServiceUp ? undefined : 'control_missing',
      detail: state.mgmt.adminServiceUp ? 'reachable from the trusted management host' : 'protected service missing — negative test would be vacuous',
    },
  ];
  if (baseline) {
    probes.splice(2, 0, {
      id: 'NEG-3',
      kind: 'negative',
      label: 'Unaffected DNS answers unchanged',
      ok: changed.length === 0,
      path: ['DNS-1'],
      failedAt: changed.length ? 'DNS-1' : undefined,
      failure: changed.length ? 'record_changed' : undefined,
      detail: changed.length ? changed.join('; ') : 'all previously correct answers identical',
    });
  }
  return probes;
}

export function fixedSuite(state: NetState, topo: Topology, journeys: Journey[], baseline?: NetState): ProbeResult[] {
  return [...journeys.map((j) => sampleJourney(state, topo, j)), ...negativeProbes(state, topo, baseline)];
}

/** Device alarms the twin can also produce (modelled = true). */
export function modelledAlarms(state: NetState, topo: Topology, probes: ProbeResult[]): Alarm[] {
  const alarms: Alarm[] = [];
  for (const probe of probes) {
    if (probe.kind !== 'journey' || probe.ok || probe.failure === 'intermittent') continue;
    alarms.push({
      id: `A-${probe.id}`,
      node: probe.path[0],
      severity: 'major',
      text: `${probe.label}: ${probe.detail}`,
      count: 1,
      modelled: true,
      cls: `journey:${probe.id}:${probe.failure}`,
    });
  }
  for (const pop of pops(topo)) {
    const decision = filterDecision(state.b17, pop.prefix!);
    if (decision.action === 'deny' && decision.rule) {
      alarms.push({
        id: `A-B17-${pop.id}`,
        node: 'B17',
        severity: 'critical',
        text: `RIB: ${pop.prefix} rejected by prefix-list EDGE-IN seq ${decision.rule.seq}`,
        count: 1,
        modelled: true,
        cls: `b17:prefix_rejected:${pop.prefix}`,
      });
    }
  }
  // Handshake alarms are traffic-driven: a listener without failing monitored traffic stays silent.
  const tlsFailures = probes.filter((p) => p.kind === 'journey' && p.failure === 'tls_expired');
  if (tlsFailures.length) {
    const cert = state.gw.certs[state.gw.bindings.v4];
    alarms.push({
      id: 'A-GW-v4',
      node: 'GW-1',
      severity: 'critical',
      text: `TLS v4 listener: ${tlsFailures.length} journeys failing handshake — certificate ${cert.serial} notAfter ${cert.notAfter.slice(11, 16)} UTC`,
      count: 1,
      modelled: true,
      cls: 'gw:cert_expired:v4',
    });
  }
  return alarms;
}
