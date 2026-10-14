import { ArrowUpRight, Radio, RotateCcw, Zap } from 'lucide-react';
import { useState } from 'react';
import { injectNetworkFault, resetNetwork, type NetworkConnection } from '../api/live.ts';
import { StatusChip } from '../components/StatusChip.tsx';
import { FAULT_INFO, SUPPORTED_FAULTS } from '../engine/harness.ts';
import type { FaultId } from '../engine/types.ts';

interface Props {
  connection?: NetworkConnection;
  error: string;
  canOperate: boolean;
  onUpdate: (connection: NetworkConnection) => void;
  onExercise: () => void;
  networkUrl?: string | null;
}

export function ConnectedApplicationContext({ connection, error, networkUrl }: Pick<Props, 'connection' | 'error' | 'networkUrl'>) {
  const ready = Boolean(!error && connection?.connected && connection.ready);
  const journeys = connection?.journeys ?? [];
  const url = connection?.url ?? networkUrl;
  return <section className="application-context" aria-label="Connected application status">
    <details><summary>Application status</summary><div className="application-context-content">
    <strong><Radio size={14} aria-hidden="true" /> Metro Network</strong>
    <p className="application-note">{ready && journeys.length
      ? `Live network: ${journeys.filter((j) => j.ok).length} of ${journeys.length} journeys operational`
      : error || connection ? 'Live measurements unavailable' : 'Loading live measurements…'}</p>
    <div className="application-links"><a href="/connections">Connected applications</a>
      {url && <a href={url} target="_blank" rel="noreferrer">Open Metro Network <ArrowUpRight size={14} aria-hidden="true" /></a>}
    </div>
    </div></details>
  </section>;
}

export function ConnectedApplication({ connection, error, canOperate, onUpdate, onExercise, networkUrl }: Props) {
  const [fault, setFault] = useState<FaultId | 'random'>('random');
  const [busy, setBusy] = useState<'inject' | 'reset' | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const ready = Boolean(!error && connection?.connected && connection.ready);
  const journeys = connection?.journeys ?? [];
  const failed = journeys.filter((j) => !j.ok).length;
  const url = connection?.url ?? networkUrl;
  const latestIssue = connection?.issues[0];
  const act = async (action: 'inject' | 'reset') => {
    setBusy(action); setActionError(''); setNotice('');
    try {
      const choice = fault === 'random' ? SUPPORTED_FAULTS[crypto.getRandomValues(new Uint32Array(1))[0] % SUPPORTED_FAULTS.length] : fault;
      const result = action === 'inject' ? await injectNetworkFault(choice) : await resetNetwork();
      onUpdate(result);
      onExercise();
      setNotice(action === 'inject' ? 'Fault injected. Waiting for automatic detection…' : 'Lab reset. Baseline measurements refreshed.');
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  return <section className="connected-application" aria-labelledby="connected-app-title">
    <header><div><p className="stage-kicker"><Radio size={13} aria-hidden="true" /> Connected application</p><h2 id="connected-app-title">Metro Network controls</h2></div>
      <StatusChip tone={ready ? 'ok' : !connection && !error ? 'pending' : 'warn'}>{ready ? 'Monitoring' : !connection && !error ? 'Connecting' : 'Unavailable'}</StatusChip>
    </header>
    <p className="application-health">{ready && journeys.length ? `${journeys.length - failed} of ${journeys.length} journeys operational` : 'Waiting for live measurements'}</p>
    <p className="application-note">{error || connection?.activity?.text || connection?.detail || 'Reading the connected network…'}</p>
    {connection?.checkedAt && <p className="application-note">Last measured <time dateTime={new Date(connection.checkedAt * 1000).toISOString()}>{new Date(connection.checkedAt * 1000).toLocaleTimeString()}</time></p>}
    <div className="application-links"><a href="/connections">Connected applications</a>{url && <a href={url} target="_blank" rel="noreferrer">Open Metro Network <ArrowUpRight size={14} aria-hidden="true" /></a>}
      {latestIssue?.incidentId && <a href={`/workbench?incident=${encodeURIComponent(latestIssue.incidentId)}`}>Review latest investigation</a>}
    </div>
    <div className="lab-exercise">
      <p className="stage-kicker">Local lab exercise</p>
      <label className="field"><span>Inject fault</span><select value={fault} onChange={(e) => setFault(e.target.value as FaultId | 'random')} disabled={Boolean(busy) || !canOperate}>
        <option value="random">Random · sealed</option>
        {SUPPORTED_FAULTS.map((id) => <option key={id} value={id}>{FAULT_INFO[id].label}</option>)}
        <option value="unsupported_link_flap">Unsupported fault (control)</option>
      </select></label>
      <div className="application-actions">
        <button type="button" className="btn-break" onClick={() => void act('inject')} disabled={!canOperate || !ready || !connection?.exercise?.canInject || Boolean(busy)}><Zap size={16} aria-hidden="true" />{busy === 'inject' ? 'Injecting fault…' : 'Inject fault'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act('reset')} disabled={!canOperate || !ready || !connection?.exercise?.canReset || Boolean(busy)}><RotateCcw size={14} aria-hidden="true" />{busy === 'reset' ? 'Resetting…' : 'Reset lab'}</button>
      </div>
      {latestIssue?.investigationStatus === 'finished' && latestIssue.status === 'open' && <p className="application-note">The investigation finished with an unresolved issue. Review its evidence or reset the lab before another exercise.</p>}
      <p className="application-note">{!canOperate ? 'Investigator access is required to run an exercise.' : connection?.recoveryRequired ? 'Operator recovery is required. Open Metro Network to inspect the lab.' : ready && !connection?.exercise ? 'Exercise controls are unavailable from this connection. Open Metro Network to run an exercise.' : connection?.issues[0]?.investigationStatus === 'investigating' ? 'An investigation owns the lab. Complete or reject its approval before another exercise.' : 'Injects a fault into the local lab. TwinOps detects the symptoms and tests repairs in its isolated twin.'}</p>
      {actionError && <p className="application-error" role="alert">{actionError}</p>}
      {notice && <p className="application-note" role="status">{notice}</p>}
    </div>
  </section>;
}
