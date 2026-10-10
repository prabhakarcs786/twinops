import { addMinutes, clone, type NetState } from './model.ts';
import { sha256 } from './sha256.ts';
import { popByIndex, pops } from './topology.ts';
import type { ActionStep, ActionType, ChallengeKind, ChangeSet, DiffLine, ParamValue, Topology } from './types.ts';

export const CATALOGUE_VERSION = 'catalogue-0.1.0';
export const POLICY_VERSION = 'policy-0.1.0';
export const MAX_BLAST_RADIUS = 2;
export const MAX_STEPS = 3;

export type Category = 'routing' | 'dns' | 'tls';
type ParamType = 'string' | 'number' | 'boolean' | 'string[]';

interface ActionSpec {
  title: string;
  category: Category;
  targets: string[];
  params: Record<string, ParamType>;
  sessionImpact: 'none' | 'reset' | 'drain';
  /** Release policy: a forbidden action can run in the twin for comparison but can never pass the gate. */
  forbidden?: string;
  touched?: (step: ActionStep, topo: Topology) => string[];
  apply: (state: NetState, step: ActionStep, topo: Topology) => void;
}

const allClients = (_: ActionStep, topo: Topology) => pops(topo).map((p) => p.id);

export const CATALOGUE: Record<ActionType, ActionSpec> = {
  restart_service: {
    title: 'Restart service process',
    category: 'routing',
    targets: ['B17', 'GW-1'],
    params: { service: 'string' },
    sessionImpact: 'reset',
    apply: () => {
      /* process restarts and reloads the same persisted configuration */
    },
  },
  rollback_config: {
    title: 'Roll back device configuration',
    category: 'routing',
    targets: ['B17'],
    params: { to_revision: 'string' },
    sessionImpact: 'none',
    apply: (state, step) => {
      const archived = state.archive[String(step.params.to_revision)];
      if (!archived) throw new Error(`revision ${step.params.to_revision} not in archive`);
      state.b17 = { ...clone(archived), steered: state.b17.steered, routingUp: state.b17.routingUp };
    },
  },
  remove_rule: {
    title: 'Remove one prefix-list entry',
    category: 'routing',
    targets: ['B17'],
    params: { seq: 'number' },
    sessionImpact: 'none',
    apply: (state, step) => {
      state.b17.prefixList = state.b17.prefixList.filter((r) => r.seq !== Number(step.params.seq));
      state.b17.revision = `${state.b17.revision.split('~')[0]}~fix`;
    },
  },
  set_route: {
    title: 'Steer prefixes over backup path',
    category: 'routing',
    targets: ['GW-1'],
    params: { prefixes: 'string[]', via: 'string' },
    sessionImpact: 'none',
    touched: (step, topo) => [step.target, popByIndex(topo, 3).id],
    apply: (state, step) => {
      const add = step.params.prefixes as string[];
      state.b17.steered = [...new Set([...state.b17.steered, ...add])];
    },
  },
  disable_filter: {
    title: 'Disable edge prefix filter',
    category: 'routing',
    targets: ['B17'],
    params: {},
    sessionImpact: 'none',
    forbidden: 'Disables security filtering on B17 — restricted management paths become reachable.',
    apply: (state) => {
      state.b17.filterEnabled = false;
    },
  },
  flush_cache: {
    title: 'Flush resolver cache',
    category: 'dns',
    targets: ['DNS-1'],
    params: { names: 'string[]' },
    sessionImpact: 'none',
    apply: (state, step) => {
      const names = step.params.names as string[];
      if (names.length === 0) state.dns.cache = {};
      for (const name of names) delete state.dns.cache[name];
    },
  },
  switch_resolver: {
    title: 'Switch clients to standby resolver',
    category: 'dns',
    targets: ['DNS-1'],
    params: { to: 'string' },
    sessionImpact: 'none',
    apply: (state, step) => {
      state.dns.active = step.params.to === 'standby' ? 'standby' : 'primary';
    },
  },
  restore_record: {
    title: 'Restore DNS record to previous value',
    category: 'dns',
    targets: ['DNS-1'],
    params: { host: 'string', value: 'string' },
    sessionImpact: 'none',
    apply: (state, step) => {
      state.dns.primary[String(step.params.host)] = String(step.params.value);
      state.dns.serial += 1;
    },
  },
  hardcode_hosts: {
    title: 'Pin address in client hosts files',
    category: 'dns',
    targets: ['clients'],
    params: { host: 'string', value: 'string' },
    sessionImpact: 'none',
    forbidden: 'Pins addresses on every client — bypasses DNS and creates unmanaged configuration drift.',
    touched: allClients,
    apply: (state, step) => {
      state.clients.hosts[String(step.params.host)] = String(step.params.value);
    },
  },
  renew_cert: {
    title: 'Renew gateway certificate',
    category: 'tls',
    targets: ['GW-1'],
    params: { listeners: 'string[]', san: 'string[]' },
    sessionImpact: 'drain',
    apply: (state, step) => {
      const serial = `c-${sha256(JSON.stringify(step.params) + state.now).slice(0, 3)}`;
      state.gw.certs[serial] = { serial, notAfter: addMinutes(state.now, 90 * 24 * 60), san: [...(step.params.san as string[])] };
      for (const listener of step.params.listeners as string[]) {
        if (listener === 'v4' || listener === 'v6') state.gw.bindings[listener] = serial;
      }
    },
  },
  extend_trust_store: {
    title: 'Accept expired certificates on clients',
    category: 'tls',
    targets: ['clients'],
    params: { accept_expired: 'boolean' },
    sessionImpact: 'none',
    forbidden: 'Makes every client accept expired certificates — weakens transport security.',
    touched: allClients,
    apply: (state, step) => {
      state.clients.acceptExpired = Boolean(step.params.accept_expired);
    },
  },
  disable_tls_validation: {
    title: 'Disable TLS validation on clients',
    category: 'tls',
    targets: ['clients'],
    params: {},
    sessionImpact: 'none',
    forbidden: 'Turns off certificate validation on every client — a security control is removed.',
    touched: allClients,
    apply: (state) => {
      state.clients.validateTls = false;
    },
  },
};

function typeOf(value: ParamValue): ParamType {
  if (Array.isArray(value)) return 'string[]';
  return typeof value as ParamType;
}

/** Schema validation for planner output: unknown actions, targets or parameters never reach the twin. */
export function validateChangeSet(cs: Pick<ChangeSet, 'steps'>): string[] {
  const errors: string[] = [];
  if (!Array.isArray(cs.steps) || cs.steps.length === 0) return ['change set has no steps'];
  if (cs.steps.length > MAX_STEPS) errors.push(`change set exceeds ${MAX_STEPS} steps`);
  for (const [i, step] of cs.steps.entries()) {
    const spec = CATALOGUE[step.action as ActionType];
    if (!spec) {
      errors.push(`step ${i + 1}: action "${String(step.action)}" is not in the typed catalogue`);
      continue;
    }
    if (!spec.targets.includes(step.target)) errors.push(`step ${i + 1}: target "${step.target}" not allowed for ${step.action}`);
    for (const [name, type] of Object.entries(spec.params)) {
      if (!(name in (step.params ?? {}))) errors.push(`step ${i + 1}: missing parameter ${name}`);
      else if (typeOf(step.params[name]) !== type) errors.push(`step ${i + 1}: parameter ${name} must be ${type}`);
    }
    for (const name of Object.keys(step.params ?? {})) {
      if (!(name in spec.params)) errors.push(`step ${i + 1}: unexpected parameter ${name}`);
    }
  }
  return errors;
}

export function applyChangeSet(state: NetState, cs: Pick<ChangeSet, 'steps'>, topo: Topology): NetState {
  const next = clone(state);
  for (const step of cs.steps) CATALOGUE[step.action].apply(next, step, topo);
  return next;
}

export function touchedNodes(cs: Pick<ChangeSet, 'steps'>, topo: Topology): string[] {
  const nodes = new Set<string>();
  for (const step of cs.steps) {
    const spec = CATALOGUE[step.action];
    for (const n of spec.touched ? spec.touched(step, topo) : [step.target]) nodes.add(n);
  }
  return [...nodes];
}

export function forbiddenReasons(cs: Pick<ChangeSet, 'steps'>): string[] {
  return cs.steps.map((s) => CATALOGUE[s.action].forbidden).filter((r): r is string => Boolean(r));
}

export function sessionImpact(cs: Pick<ChangeSet, 'steps'>): 'none' | 'reset' | 'drain' {
  const impacts = cs.steps.map((s) => CATALOGUE[s.action].sessionImpact);
  return impacts.includes('reset') ? 'reset' : impacts.includes('drain') ? 'drain' : 'none';
}

export function categoryOf(cs: Pick<ChangeSet, 'steps'>): Category {
  const [first] = cs.steps;
  if (first.action === 'restart_service') return first.target === 'GW-1' ? 'tls' : 'routing';
  return CATALOGUE[first.action].category;
}

export function requiredChallenges(cs: Pick<ChangeSet, 'steps'>): ChallengeKind[] {
  const byCategory: Record<Category, ChallengeKind[]> = {
    routing: ['dual_stack', 'secondary_failure', 'surge_x3'],
    dns: ['warm_cache', 'surge_x3'],
    tls: ['dual_stack', 'session_continuity'],
  };
  const required = cs.steps.flatMap((step) => byCategory[categoryOf({ steps: [step] })]);
  if (sessionImpact(cs) !== 'none') required.push('session_continuity');
  return [...new Set(required)];
}

const DIFF_SCOPE = ['b17', 'dns', 'clients', 'gw', 'notes'] as const;
const NODE_OF: Record<(typeof DIFF_SCOPE)[number], string> = {
  b17: 'B17',
  dns: 'DNS-1',
  clients: 'clients',
  gw: 'GW-1',
  notes: 'B17',
};

function render(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => (v && typeof v === 'object' && 'seq' in v ? `seq ${v.seq} ${v.action} ${v.prefix}` : String(v)))
      .join(' | ');
  }
  return String(value);
}

function flatten(value: unknown, prefix: string, out: Record<string, string>) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = render(value);
  }
}

export function diffStates(before: NetState, after: NetState): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const section of DIFF_SCOPE) {
    const a: Record<string, string> = {};
    const b: Record<string, string> = {};
    flatten(before[section], section, a);
    flatten(after[section], section, b);
    for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[path] !== b[path]) lines.push({ node: NODE_OF[section], path, before: a[path] ?? '—', after: b[path] ?? '—' });
    }
  }
  return lines;
}

export function describeStep(step: ActionStep): string {
  const params = Object.entries(step.params)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join(' ');
  return `${step.action}(${step.target}${params ? ` ${params}` : ''})`;
}
