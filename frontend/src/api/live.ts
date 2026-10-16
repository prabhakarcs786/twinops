import type { ApplyOutcome, RunResult } from '../engine/orchestrator.ts';
import type { ApprovalRecord, FaultId, PackId, RunEvent, ScenarioVariant } from '../engine/types.ts';
import type { IncidentLifecycle, NetworkConnection } from './contracts.ts';
export type { ConnectionIssue, NetworkConnection } from './contracts.ts';

/** Client for the TwinOps backend (FastAPI + SSE). Same event and run shapes as the in-browser engine. */

export interface BackendConfig {
  role?: 'viewer' | 'investigator' | 'approver' | null;
  applyEnabled?: boolean;
  authenticationRequired?: boolean;
  version: string;
  planner: { kind: string; provider: string; model: string; mode: string; version: string };
  twin: { backend: 'model' | 'emulated'; ready: boolean; detail: string };
  approvalAuth: boolean;
  demoApproval?: boolean;
  harness: boolean;
  connectedApplication?: boolean;
  networkUrl?: string | null;
  variants?: { id: ScenarioVariant; label: string }[];
}

export interface Narrative {
  summary: string;
  evidenceIds: string[];
  authoritative: false;
  model: string;
}

export interface LiveIncident {
  lifecycle?: IncidentLifecycle;
  incidentId: string;
  status: string;
  seed: number;
  run: (RunResult & { planner?: { kind: string; provider: string; model: string } }) | null;
  approval: ApprovalRecord | null;
  outcome: ApplyOutcome | null;
  narrative: Narrative | null;
  error: string | null;
  createdAt: number;
  recovered: boolean;
  pack: PackId;
}

export interface IncidentSummary {
  incidentId: string;
  createdAt: number;
  seed: number;
  status: string;
  pack: PackId;
  verdict: string | null;
  outcome: string | null;
  cause?: string | null;
  fix?: string | null;
  reused?: boolean;
  affected?: number;
  journeys?: number;
  verdictMs?: number | null;
  restoredMs?: number | null;
}

export const fetchHistory = () => json<IncidentSummary[]>('/api/incidents');

const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return (await res.json()) as T;
}

// Config includes read-only device readiness checks, which can take a few seconds on startup.
export async function fetchConfig(timeoutMs = 5000): Promise<BackendConfig | null> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await json<BackendConfig>('/api/config', { signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

export const createIncident = (body: { pack: PackId; fault: 'random' | FaultId; pace: number; seed?: number; variant?: ScenarioVariant; useMemory?: boolean; simulateOutage?: boolean }) =>
  json<{ incidentId: string; seed: number; eventsUrl: string; createdAt: number }>('/api/incidents', { method: 'POST', body: JSON.stringify(body) });

export const getIncident = (id: string) => json<LiveIncident>(`/api/incidents/${encodeURIComponent(id)}`);

export const fetchConnection = (signal?: AbortSignal) => json<NetworkConnection>('/api/connections', { signal });
export const injectNetworkFault = (fault: FaultId) => json<NetworkConnection>('/api/connections/network/fault', { method: 'POST', body: JSON.stringify({ fault }) });
export const resetNetwork = () => json<NetworkConnection>('/api/connections/network/reset', { method: 'POST', body: '{}' });
const auth = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

export const postDecision = (id: string, body: { decision: 'approve' | 'reject'; operator: string; comment: string }, token?: string) =>
  json<{ status: string; outcome: ApplyOutcome }>(`/api/incidents/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(body), headers: auth(token) });

export const postDrift = (id: string, token?: string) =>
  json<{ status: string }>(`/api/incidents/${encodeURIComponent(id)}/drift`, { method: 'POST', headers: auth(token) });

export const getReveal = (id: string) => json<{ code: string; label: string; description: string }>(`/api/incidents/${encodeURIComponent(id)}/reveal`);

export interface AskAnswer {
  answer: string;
  answerable: boolean;
  evidenceIds: string[];
  discardedIds: string[];
  model: string;
  latencyMs: number;
  tokens: number;
  remaining: number;
  authoritative: false;
}

export const askIncident = (id: string, question: string) =>
  json<AskAnswer>(`/api/incidents/${encodeURIComponent(id)}/ask`, { method: 'POST', body: JSON.stringify({ question }) });

export const proofPackUrl = (id: string, format: 'json' | 'html') => `${API}/api/incidents/${encodeURIComponent(id)}/proof-pack?format=${format}`;

export type ReviewMode = 'raw' | 'proof';
export type ReviewDecision = 'accept' | 'reject' | 'more_evidence';
export interface ReviewStarted { trialId: string; startedAt: number; mode: ReviewMode; candidateId: string }
export interface ReviewResult extends ReviewStarted { decision: ReviewDecision; elapsedMs: number; gateAgreement: boolean; expectedDecision: ReviewDecision }
export interface ReviewSummary {
  totalTrials: number;
  pairedTasks: number;
  modes: { mode: ReviewMode; trials: number; gateAgreements: number; medianMs: number | null }[];
  note: string;
}
export const startReview = (id: string, candidateId: string, mode: ReviewMode, assignmentId?: string) =>
  json<ReviewStarted>(`/api/incidents/${encodeURIComponent(id)}/review-trials`, { method: 'POST', body: JSON.stringify({ candidateId, mode, assignmentId }) });
export const finishReview = (id: string, decision: ReviewDecision) =>
  json<ReviewResult>(`/api/review-trials/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
export const fetchReviewSummary = () => json<ReviewSummary>('/api/review-trials/summary');
export const reviewExportUrl = `${API}/api/review-trials`;

export interface EvaluationReport {
  name: string;
  generatedAt: string;
  planner: { kind: string; provider: string; model: string; version: string };
  seeds: number;
  pack: string;
  startSeed: number;
  suiteVersion: string;
  variant?: ScenarioVariant;
  note: string;
  byFault: Record<string, { runs: number; top1: number; top3: number; verdictOk: number; fallbackFreeSuccess?: number; abstentions?: number; unsafePassed: number; fallbacks: number; rejectedOutputs: number; modelCalls: number; tokens: number; medianComputeMs: number; p95ComputeMs?: number }>;
  controls: { id: string; name?: string; ok: boolean; scope?: string; fallbacks?: number; modelCalls?: number; planner?: { kind: string; provider: string; model: string } }[];
}

export const fetchReports = () => json<EvaluationReport[]>('/api/evaluation/reports');

/** Subscribes to the incident's SSE stream; EventSource reconnects automatically with Last-Event-ID. */
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function subscribe(eventsUrl: string, onEvent: (e: RunEvent) => void, onEnd: (status: string) => void, onState: (state: StreamState) => void): () => void {
  const source = new EventSource(`${API}${eventsUrl}`, { withCredentials: true });
  onState('connecting');
  source.onopen = () => onState('connected');
  source.addEventListener('run', (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as RunEvent));
  source.addEventListener('end', (msg) => {
    onEnd((JSON.parse((msg as MessageEvent<string>).data) as { status: string }).status);
    source.close();
    onState('closed');
  });
  source.onerror = () => {
    onState(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  };
  return () => source.close();
}
