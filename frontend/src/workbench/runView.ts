import { proofPackUrl, type Narrative } from '../api/live.ts';
import { buildProofPack, type ApplyOutcome, type IncidentSession, type RunResult } from '../engine/orchestrator.ts';
import type { ApprovalRecord } from '../engine/types.ts';
import { download, proofPackHtml } from './proofPackHtml.ts';

/** How the observed network is named: the synthetic demo, or a connected application such as Metro Network. */
export interface TargetCopy { name: string; prose: string; kicker: string; note: string; impact: string }
export const DEMO_TARGET: TargetCopy = { name: 'Demo network', prose: 'the demo network', kicker: 'Production stand-in', note: 'Synthetic · read-only to TwinOps · writes only via approved apply gateway', impact: 'Demo service impact' };
export const CONNECTED_TARGET: TargetCopy = { name: 'Metro Network', prose: 'Metro Network', kicker: 'Connected application', note: 'Real Containerlab lab · observed through its API · writes only via approved apply gateway', impact: 'Metro Network service impact' };

/** What the evidence and approval UI needs, independent of where the run executed. */
export interface RunView {
  run: RunResult;
  outcome?: ApplyOutcome | null;
  approval?: ApprovalRecord | null;
  narrative?: Narrative | null;
  downloadJson: () => void;
  downloadHtml: () => void;
}

export function localView(session: IncidentSession): RunView {
  return {
    run: session.run,
    outcome: session.outcome,
    approval: session.approval,
    narrative: null,
    downloadJson: () => download(`${session.run.runId}-proof-pack.json`, JSON.stringify(buildProofPack(session), null, 2), 'application/json'),
    downloadHtml: () => download(`${session.run.runId}-proof-pack.html`, proofPackHtml(buildProofPack(session)), 'text/html'),
  };
}

function navigateDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function liveView(id: string, run: RunResult, outcome: ApplyOutcome | null, approval: ApprovalRecord | null, narrative: Narrative | null): RunView {
  return {
    run,
    outcome,
    approval,
    narrative,
    downloadJson: () => navigateDownload(proofPackUrl(id, 'json')),
    downloadHtml: () => navigateDownload(proofPackUrl(id, 'html')),
  };
}
