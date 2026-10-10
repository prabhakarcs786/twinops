/**
 * Shared contract objects. Field names follow the HLD/LLD (IncidentSnapshot, CandidateChange,
 * TestResult, GateDecision, ApprovalRecord) so a FastAPI backend can stream the same shapes.
 */

export type PackId = 'core' | 'enterprise';
export type NodeRole = 'pop' | 'core' | 'dns' | 'gateway' | 'service';

export interface TopoNode {
  id: string;
  label: string;
  short: string;
  role: NodeRole;
  x: number;
  y: number;
  prefix?: string;
  v6Prefix?: string;
}

export interface TopoLink {
  id: string;
  a: string;
  b: string;
  latencyMs: number;
  backup?: boolean;
}

export interface Journey {
  id: string;
  label: string;
  from: string;
  host: string;
}

export interface Topology {
  pack: PackId;
  name: string;
  version: string;
  nodes: TopoNode[];
  links: TopoLink[];
  journeys: Journey[];
}

/** Known only to the demo harness and the evaluator — never passed to the planner. */
export type FaultId = 'route_misconfig' | 'dns_failure' | 'cert_expiry' | 'unsupported_link_flap';

export type FailureClass =
  | 'no_route'
  | 'wrong_address'
  | 'tls_expired'
  | 'tls_name'
  | 'intermittent'
  | 'node_down'
  | 'slo_breach'
  | 'exposed'
  | 'validation_off'
  | 'record_changed'
  | 'control_missing';

export type ProbeKind = 'journey' | 'negative' | 'control' | 'challenge' | 'diagnostic';

export interface ProbeResult {
  id: string;
  kind: ProbeKind;
  label: string;
  ok: boolean;
  path: string[];
  failedAt?: string;
  failure?: FailureClass;
  detail: string;
  latencyMs?: number;
}

export interface Alarm {
  id: string;
  node: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
  text: string;
  count: number;
  /** false = outside the twin's supported fidelity (hardware, optics, sensors). */
  modelled: boolean;
  cls: string;
}

export interface ChangeRecord {
  id: string;
  node: string;
  minutesAgo: number;
  author: string;
  summary: string;
  parent?: string;
  before?: Record<string, string>;
  after?: Record<string, string>;
}

export interface LogLine {
  id: string;
  node: string;
  text: string;
  flagged?: boolean;
}

export interface Observation {
  capturedAt: string;
  stateHash: string;
  probes: ProbeResult[];
  alarms: Alarm[];
  changes: ChangeRecord[];
  logs: LogLine[];
  rawEventCount: number;
  /** Pre-incident p50 latency per journey from monitoring history. */
  baselines: Record<string, number>;
}

export type HypothesisType =
  | 'edge_filter_regression'
  | 'dns_record_incorrect'
  | 'tls_certificate_expired'
  | 'physical_link_degradation'
  | 'service_unavailable';

export interface Hypothesis {
  id: string;
  rank: number;
  type: HypothesisType;
  target: string;
  title: string;
  supporting: string[];
  contradicting: string[];
  rationale: string;
  score: number;
}

export type ActionType =
  | 'restart_service'
  | 'rollback_config'
  | 'remove_rule'
  | 'set_route'
  | 'disable_filter'
  | 'flush_cache'
  | 'switch_resolver'
  | 'restore_record'
  | 'hardcode_hosts'
  | 'renew_cert'
  | 'extend_trust_store'
  | 'disable_tls_validation';

export type ParamValue = string | number | boolean | string[];

export interface ActionStep {
  action: ActionType;
  target: string;
  params: Record<string, ParamValue>;
}

export type CandidateOrigin = 'runbook' | 'llm' | 'revision' | 'evaluation_case';

export interface ChangeSet {
  id: string;
  label: string;
  steps: ActionStep[];
  origin: CandidateOrigin;
  parentId?: string;
  rationale: string;
  hash: string;
}

export interface DiffLine {
  node: string;
  path: string;
  before: string;
  after: string;
}

export type ChallengeKind = 'dual_stack' | 'secondary_failure' | 'surge_x3' | 'warm_cache' | 'session_continuity';

export interface ChallengeResult {
  id: string;
  kind: ChallengeKind;
  label: string;
  ok: boolean;
  soft: boolean;
  detail: string;
  probes: ProbeResult[];
}

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8';
export type GateStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'pending';

export interface GateCheck {
  id: GateId;
  status: GateStatus;
  reason: string;
}

export type CandidateDecision = 'pass' | 'pass_with_warnings' | 'rejected' | 'superseded';

export interface CandidateRecord {
  change: ChangeSet;
  diff: DiffLine[];
  touched: string[];
  fixed: ProbeResult[];
  challenges: ChallengeResult[];
  rollback: { rehearsed: boolean; matches: boolean; restoredHash: string };
  gates: GateCheck[];
  decision: CandidateDecision;
  reasons: string[];
  restored: boolean;
  latencyDeltaMs: number;
  forbidden: boolean;
}

export type Verdict = 'PASS_UNDER_DEFINED_TESTS' | 'PASS_WITH_WARNINGS' | 'REJECTED' | 'INCONCLUSIVE' | 'ESCALATE';

export interface Reproduction {
  matched: number;
  total: number;
  affectedReproduced: boolean;
  passed: boolean;
  mismatches: string[];
  outOfScope: string[];
  slice: string[];
  twinProbes: ProbeResult[];
}

export interface ApprovalRecord {
  runId: string;
  candidateId: string;
  changeHash: string;
  targetStateHash: string;
  operator: string;
  comment: string;
  decision: 'approve' | 'reject';
  decidedAt: string;
  token: string;
}

export type Phase = 'idle' | 'break' | 'observe' | 'diagnose' | 'reproduce' | 'experiment' | 'challenge' | 'gate' | 'approve' | 'apply';

export type Tone = 'info' | 'ok' | 'fail' | 'warn' | 'ai' | 'twin' | 'prod';

export type Actor = 'harness' | 'observer' | 'guard' | 'diagnosis' | 'twin' | 'experiment' | 'challenge' | 'gate' | 'operator' | 'apply';

export type EventKind =
  | 'fault_injected'
  | 'observed'
  | 'guard'
  | 'hypotheses'
  | 'twin_ready'
  | 'reproduced'
  | 'not_reproduced'
  | 'experiment_result'
  | 'challenge_probe'
  | 'revised'
  | 'candidate_decision'
  | 'gate_verdict'
  | 'awaiting_approval'
  | 'escalated'
  | 'approval_recorded'
  | 'approval_rejected'
  | 'drift_detected'
  | 'applied'
  | 'post_check'
  | 'rolled_back'
  | 'recovery_required'
  | 'planner_note'
  | 'model_call'
  | 'narrative'
  | 'run_failed';

export interface CandidateSummary {
  id: string;
  label: string;
  origin: CandidateOrigin;
  status: 'testing' | 'challenging' | 'pass' | 'warn' | 'rejected' | 'superseded';
  note: string;
  forbidden: boolean;
}

export interface Counters {
  experiments: number;
  revisions: number;
  unsafeRejected: number;
  probesRun: number;
  challengesRun: number;
  productionWritesDuringDiagnosis: number;
}

export interface TwinFrame {
  slice: string[];
  probes: Record<string, ProbeResult>;
  failedNodes: string[];
  focus: string[];
  caption: string;
  state: 'building' | 'reproduced' | 'not_reproduced' | 'experiment' | 'challenge' | 'idle';
}

export interface Frame {
  phase: Phase;
  prod: {
    probes: Record<string, ProbeResult>;
    alarmNodes: string[];
    status: 'healthy' | 'incident' | 'restored';
  };
  twin: TwinFrame | null;
  hypotheses: Hypothesis[];
  candidates: CandidateSummary[];
  counters: Counters;
  verdict?: Verdict;
  selectedId?: string;
}

export interface RunEvent {
  seq: number;
  at: number;
  kind: EventKind;
  phase: Phase;
  actor: Actor;
  tone: Tone;
  title: string;
  summary: string;
  raw: unknown;
  frame: Frame;
}

export interface Versions {
  engine: string;
  topology: string;
  catalogue: string;
  policy: string;
  planner: string;
}
