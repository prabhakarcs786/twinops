import { proofPackUrl, type Narrative } from '../api/live.ts';
import { buildProofPack, type ApplyOutcome, type IncidentSession, type RunResult } from '../engine/orchestrator.ts';
import type { ApprovalRecord } from '../engine/types.ts';
import { download, proofPackHtml } from './proofPackHtml.ts';

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
