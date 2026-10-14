import type { ApplyOutcome } from '../engine/orchestrator.ts';
import type { ProbeResult, Topology } from '../engine/types.ts';

export interface Provenance {
  classification: 'measured' | 'model-derived' | 'synthetic' | 'interpreted' | 'unavailable';
  source: string;
  observedAt: string;
  snapshotId: string;
  stateHash: string;
}

export interface EvidenceSnapshot {
  schemaVersion: 'evidence-1';
  id: string;
  stateHash: string;
  capturedStateHash: string;
  collectedAt: string;
  collectedAtEpoch: number;
  durationMs: number;
  consistent: boolean;
  source: string;
}

export interface Investigation {
  schemaVersion: 'investigation-1';
  rounds: { round: number; hypothesisBefore: string; hypothesisAfter: string; question: string; evidence: ProbeResult }[];
  probeBudget: number;
  sufficient: boolean;
  stopReason: string;
}

export interface TwinCoverage {
  schemaVersion: 'coverage-1';
  adequate: boolean;
  missingCritical: string[];
  affectedJourneys: string[];
  testedJourneys: string[];
  representedNodes: string[];
  totalNodes: number;
  capabilities: string[];
  limitations: string[];
}

export interface IncidentLifecycle {
  schemaVersion: 'incident-1';
  status: 'running' | 'awaiting_approval' | 'applying' | 'closed' | 'failed' | 'escalated' | 'recovery_required';
  revision: number;
  phase: string;
  terminal: boolean;
  archived: boolean;
  canApprove: boolean;
  canReject: boolean;
  evidenceFresh: boolean;
  evidenceExpiresAt: number;
  applyEnabled: boolean;
  outcome: ApplyOutcome | null;
  operationId: string | null;
  nextAction: string;
}

export interface ConnectionIssue {
  id: string; title: string; status: string; incidentId: string | null; detectedAt: number;
  resolvedAt?: number; failedJourneys?: string[]; investigationStatus?: string;
}
export interface NetworkConnection {
  configured: boolean; connected: boolean; ready?: boolean; name?: string; detail?: string;
  url?: string; checkedAt?: number; recoveryRequired?: boolean; operation?: string | null;
  activity?: { kind: string; text: string } | null;
  topology?: Topology; probes?: ProbeResult[]; alarmNodes?: string[];
  journeys?: { id: string; label: string; ok: boolean }[];
  exercise?: { canInject: boolean; canReset: boolean };
  issues: ConnectionIssue[];
}
