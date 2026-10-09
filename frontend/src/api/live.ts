import type { ApplyOutcome, RunResult } from '../engine/orchestrator.ts';
import type { ApprovalRecord, FaultId, PackId, RunEvent } from '../engine/types.ts';

/** Client for the TwinOps backend (FastAPI + SSE). Same event and run shapes as the in-browser engine. */

export interface BackendConfig {
  version: string;
  planner: { kind: string; provider: string; model: string; mode: string; version: string };
  twin: { backend: 'model' | 'emulated'; ready: boolean; detail: string };
  approvalAuth: boolean;
  harness: boolean;
}

export interface Narrative {
  summary: string;
  evidenceIds: string[];
  authoritative: false;
  model: string;
}

export interface LiveIncident {
  incidentId: string;
  status: string;
  seed: number;
  run: (RunResult & { planner?: { kind: string; provider: string; model: string } }) | null;
  approval: ApprovalRecord | null;
  outcome: ApplyOutcome | null;
  narrative: Narrative | null;
  error: string | null;
}

const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
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

export async function fetchConfig(timeoutMs = 1500): Promise<BackendConfig | null> {
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

export const createIncident = (body: { pack: PackId; fault: 'random' | FaultId; pace: number }) =>
  json<{ incidentId: string; seed: number; eventsUrl: string }>('/api/incidents', { method: 'POST', body: JSON.stringify(body) });

export const getIncident = (id: string) => json<LiveIncident>(`/api/incidents/${encodeURIComponent(id)}`);

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

export interface EvaluationReport {
  name: string;
  generatedAt: string;
  planner: { kind: string; provider: string; model: string; version: string };
  seeds: number;
  byFault: Record<string, { runs: number; top1: number; top3: number; verdictOk: number; unsafePassed: number; fallbacks: number; rejectedOutputs: number; modelCalls: number; tokens: number; medianComputeMs: number }>;
  controls: { id: string; ok: boolean }[];
}

export const fetchReports = () => json<EvaluationReport[]>('/api/evaluation/reports');

/** Subscribes to the incident's SSE stream; EventSource reconnects automatically with Last-Event-ID. */
export function subscribe(eventsUrl: string, onEvent: (e: RunEvent) => void, onEnd: (status: string) => void, onError: () => void): () => void {
  const source = new EventSource(`${API}${eventsUrl}`);
  source.addEventListener('run', (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as RunEvent));
  source.addEventListener('end', (msg) => {
    onEnd((JSON.parse((msg as MessageEvent<string>).data) as { status: string }).status);
    source.close();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onError();
  };
  return () => source.close();
}
