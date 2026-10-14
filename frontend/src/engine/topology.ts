import type { PackId, Topology, TopoNode } from './types.ts';

export const SERVICE_IPS: Record<string, string> = {
  'svc.demo': '10.40.0.10',
  'api.demo': '10.40.0.11',
};

export const MGMT_PREFIX = '10.99.0.0/16';
export const SLO_LATENCY_MS = 40;
export const LATENCY_BUDGET_MS = 10;

interface PopLabel {
  id: string;
  label: string;
  short: string;
}

const PACKS: Record<PackId, { name: string; pops: [PopLabel, PopLabel, PopLabel, PopLabel] }> = {
  core: {
    name: 'Regional core (synthetic)',
    pops: [
      { id: 'BER', label: 'Berlin PoP', short: 'BER' },
      { id: 'MUC', label: 'Munich PoP', short: 'MUC' },
      { id: 'HAM', label: 'Hamburg PoP', short: 'HAM' },
      { id: 'FRA', label: 'Frankfurt PoP', short: 'FRA' },
    ],
  },
  enterprise: {
    name: 'Hybrid enterprise (synthetic)',
    pops: [
      { id: 'HQ', label: 'Headquarters', short: 'HQ' },
      { id: 'APAC', label: 'Region APAC', short: 'APAC' },
      { id: 'EU', label: 'Region EU', short: 'EU' },
      { id: 'DC', label: 'Data centre', short: 'DC' },
    ],
  },
  branch: {
    name: 'Branch transit topology (synthetic)',
    pops: [
      { id: 'BER', label: 'Berlin PoP', short: 'BER' },
      { id: 'MUC', label: 'Munich PoP', short: 'MUC' },
      { id: 'HAM', label: 'Hamburg PoP', short: 'HAM' },
      { id: 'FRA', label: 'Frankfurt PoP', short: 'FRA' },
    ],
  },
};

export const PACK_OPTIONS: { id: PackId; name: string }[] = [
  { id: 'core', name: PACKS.core.name },
  { id: 'enterprise', name: PACKS.enterprise.name },
  { id: 'branch', name: PACKS.branch.name },
];

/**
 * One 8-node topology, two label packs. PoP order matters: pop0/pop2 share 10.20.0.0/15,
 * pop3 hosts the low-capacity backup path to the gateway.
 */
export function buildTopology(pack: PackId): Topology {
  const [p0, p1, p2, p3] = PACKS[pack].pops;
  const pop = (p: PopLabel, x: number, y: number, octet: number): TopoNode => ({
    ...p,
    role: 'pop',
    x,
    y,
    prefix: `10.${octet}.0.0/16`,
    v6Prefix: `2001:db8:${octet}::/48`,
  });
  const nodes: TopoNode[] = [
    pop(p2, 64, 54, 21),
    pop(p0, 64, 130, 20),
    pop(p3, 64, 206, 23),
    pop(p1, 64, 282, 22),
    { id: 'B17', label: 'Core router B17', short: 'B17', role: 'core', x: 252, y: 168 },
    { id: 'DNS-1', label: 'Resolver DNS-1', short: 'DNS-1', role: 'dns', x: 252, y: 46 },
    { id: 'GW-1', label: 'TLS gateway GW-1', short: 'GW-1', role: 'gateway', x: 404, y: 168 },
    { id: 'SVC-1', label: 'Service SVC-1', short: 'SVC-1', role: 'service', x: 508, y: 168 },
  ];
  const topology: Topology = {
    pack,
    name: PACKS[pack].name,
    version: `topo-${pack}-1.0.0`,
    nodes,
    links: [
      { id: 'L1', a: p0.id, b: 'B17', latencyMs: 4 },
      { id: 'L2', a: p1.id, b: 'B17', latencyMs: 6 },
      { id: 'L3', a: p2.id, b: 'B17', latencyMs: 5 },
      { id: 'L4', a: p3.id, b: 'B17', latencyMs: 3 },
      { id: 'L5', a: p0.id, b: p2.id, latencyMs: 3 },
      { id: 'L6', a: p0.id, b: p3.id, latencyMs: 12, backup: true },
      { id: 'L7', a: p1.id, b: p3.id, latencyMs: 4 },
      { id: 'L8', a: p3.id, b: 'GW-1', latencyMs: 12, backup: true },
      { id: 'L9', a: 'B17', b: 'GW-1', latencyMs: 2 },
      { id: 'L10', a: 'B17', b: 'DNS-1', latencyMs: 1 },
      { id: 'L11', a: 'GW-1', b: 'SVC-1', latencyMs: 1 },
    ],
    journeys: [
      { id: 'J1', label: `${p0.short} customers → svc.demo`, from: p0.id, host: 'svc.demo' },
      { id: 'J2', label: `${p1.short} customers → api.demo`, from: p1.id, host: 'api.demo' },
      { id: 'J3', label: `${p2.short} customers → svc.demo`, from: p2.id, host: 'svc.demo' },
      { id: 'J4', label: `${p3.short} customers → api.demo`, from: p3.id, host: 'api.demo' },
    ],
  };
  if (pack === 'branch') {
    topology.nodes.push(pop({ id: 'BRANCH', label: 'Branch office', short: 'BR' }, 150, 310, 24));
    topology.links = topology.links.filter((link) => link.id !== 'L1');
    topology.links.push({ id: 'L12', a: 'BRANCH', b: p1.id, latencyMs: 3 });
    topology.links.push({ id: 'L13', a: p0.id, b: p1.id, latencyMs: 6 });
    topology.journeys.push({ id: 'J5', label: 'Branch customers → svc.demo', from: 'BRANCH', host: 'svc.demo' });
  }
  return topology;
}

export function pathBetween(topo: Topology, start: string, end: string, excluded: string[] = []): string[] {
  const queue = [{ cost: 0, path: [start] }];
  const visited = new Set(excluded);
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const { cost, path } = queue.shift()!;
    const node = path.at(-1)!;
    if (visited.has(node)) continue;
    if (node === end) return path;
    visited.add(node);
    for (const link of topo.links) {
      if (link.backup) continue;
      const other = link.a === node ? link.b : link.b === node ? link.a : null;
      if (other && !visited.has(other)) queue.push({ cost: cost + link.latencyMs, path: [...path, other] });
    }
  }
  return [];
}

export const pops = (topo: Topology) => topo.nodes.filter((n) => n.role === 'pop');
export const nodeById = (topo: Topology, id: string) => topo.nodes.find((n) => n.id === id);
/** PoP order as declared in the pack (pop0..pop3), independent of drawing order. */
export function popByIndex(topo: Topology, index: 0 | 1 | 2 | 3) {
  const order = [topo.journeys[0].from, topo.journeys[1].from, topo.journeys[2].from, topo.journeys[3].from];
  return nodeById(topo, order[index])!;
}

export function findLink(topo: Topology, a: string, b: string) {
  return topo.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
}
