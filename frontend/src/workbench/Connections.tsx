import { ArrowUpRight, Radio, Server, ShieldCheck } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';
import { Link } from '../lib/router.tsx';
import '../styles/connections.css';
import { useConnection } from './useConnection.ts';
import type { ConnectionIssue as Issue } from '../api/live.ts';

const duration = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** Same lifecycle wording as Metro Network's incident desk, so both apps describe one incident identically. */
function issueState(issue: Issue, current: boolean, operation?: string | null): { tone: ChipTone; label: string; detail: string } {
  if (issue.status === 'resolved') return { tone: 'ok', label: 'Recovery verified', detail: issue.resolvedAt ? `Recovered in ${duration(issue.resolvedAt - issue.detectedAt)}` : 'Fresh probes confirm recovery' };
  if (issue.status === 'reset') return { tone: 'skip', label: 'Reset by operator', detail: 'Closed without a verified recovery' };
  if (issue.investigationStatus === 'recovery_required') return { tone: 'fail', label: 'Operator recovery required', detail: 'A change was interrupted or rollback could not be verified' };
  if (current && operation === 'applying') return { tone: 'warn', label: 'Applying approved change', detail: 'Metro Network is applying the change you approved' };
  if (current && operation === 'applied') return { tone: 'warn', label: 'Verifying recovery', detail: 'Approved change applied · confirming with fresh probes' };
  if (issue.investigationStatus === 'finished') return { tone: 'fail', label: 'Needs attention', detail: 'Investigation finished without a verified recovery' };
  if (issue.incidentId) return { tone: 'pending', label: 'Investigating', detail: 'Reproducing in the isolated twin and testing fixes' };
  return { tone: 'fail', label: 'Service disruption', detail: 'Waiting for TwinOps to pick up the issue' };
}

export function Connections({ theme, onToggleTheme }: { theme: 'dark' | 'light'; onToggleTheme: () => void }) {
  const { connection, error } = useConnection();
  const live = !error && connection?.connected && connection.ready;
  const loading = !connection && !error;
  const notConfigured = connection?.configured === false;
  const journeys = live ? connection.journeys ?? [] : [];
  const operational = journeys.filter((j) => j.ok).length;
  const journeyLabel = (id: string) => connection?.journeys?.find((j) => j.id === id)?.label ?? id;
  return <div className="connections-page">
    <SiteHeader variant="app" theme={theme} onToggleTheme={onToggleTheme} />
    <main id="main" className="connections-main" tabIndex={-1}>
      <h1>Connected applications</h1>
      <p className="connections-lede">Monitor application health and open an investigation. Use the workbench to run a lab exercise and review tested repairs.</p>
      {error && <p role="alert" className="connection-alert">{error}</p>}
      <section className="connection-card" aria-label="Metro Network connection">
        <div className="connection-app-icon" aria-hidden="true"><Server size={30} /></div>
        <div className="connection-app-info"><p className="eyebrow">NETWORK OPERATIONS</p><h2>Metro Network</h2><p>{connection?.detail || (notConfigured ? 'Not connected in this deployment' : 'Connecting to the network application…')}</p>
          {connection?.checkedAt && <small>Last service measurement: {new Date(connection.checkedAt * 1000).toLocaleTimeString()}</small>}
        </div>
        <div className="connection-card-actions">
          <StatusChip tone={loading ? 'pending' : live ? 'ok' : notConfigured ? 'skip' : 'warn'}>{loading ? 'Connecting…' : live ? 'Monitoring' : notConfigured ? 'Not configured' : 'Unavailable'}</StatusChip>
          <Link className="btn btn-primary btn-sm" to="/workbench">Open workbench <ArrowUpRight size={15} aria-hidden="true" /></Link>
          {connection?.url && <a className="btn btn-ghost btn-sm" href={connection.url} target="_blank" rel="noreferrer">Open application <ArrowUpRight size={15} aria-hidden="true" /></a>}
        </div>
        {!!journeys.length && <ul className="journey-health" aria-label="Live service journeys">
          <li className="journey-health-summary">{operational} of {journeys.length} journeys operational</li>
          {journeys.map((j) => <li key={j.id}><StatusChip tone={j.ok ? 'ok' : 'fail'}>{j.id}</StatusChip>{j.label}</li>)}
        </ul>}
      </section>
      {notConfigured && <p className="connection-alert">This deployment runs the simulated network model only. Metro Network and its Containerlab twin need Docker, so they run where you start <code>npm run dev:connected</code>: your machine or the lab VM.</p>}
      {connection?.recoveryRequired && <p role="alert" className="connection-alert">The network requires operator recovery. Further changes are blocked.</p>}
      <div className="connections-explainer"><span><Radio size={17} aria-hidden="true" /> Automatic issue detection</span><span><Server size={17} aria-hidden="true" /> Isolated Containerlab twin</span><span><ShieldCheck size={17} aria-hidden="true" /> Approval before live changes</span></div>
      <section className="connected-issues"><div className="connected-section-heading"><h2>Detected incidents</h2><span>{connection?.issues.length ?? 0} recorded</span></div>
        {!connection?.issues.length ? <div className="connections-empty"><Radio size={32} aria-hidden="true" /><h3>{live ? 'Watching for new service issues' : loading ? 'Checking for service issues…' : notConfigured ? 'No connected application' : 'Waiting for the network application'}</h3><p>{notConfigured ? 'Open the workbench to investigate an incident on the simulated network model.' : 'Open the workbench to see the network and inject a lab fault. TwinOps detects new issues automatically.'}</p></div> :
          connection.issues.map((issue, index) => {
            const state = issueState(issue, index === 0, connection.operation);
            const active = !['resolved', 'reset'].includes(issue.status);
            const failed = (issue.failedJourneys ?? []).map(journeyLabel).join(' · ');
            const timing = active ? `open for ${duration((connection.checkedAt ?? issue.detectedAt) - issue.detectedAt)}` : state.detail;
            return <article className={`connected-issue tone-${state.tone} ${active ? 'is-active' : ''}`} key={issue.id}><div><StatusChip tone={state.tone}>{state.label}</StatusChip><h3>{issue.title}</h3>
              <p>{new Date(issue.detectedAt * 1000).toLocaleString()} · {timing}{failed && ` · ${failed}`}</p>{active && <p>{state.detail}</p>}</div>
              {issue.incidentId ? <Link className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`} to={`/workbench?incident=${encodeURIComponent(issue.incidentId)}`}>Open investigation <ArrowUpRight size={15} aria-hidden="true" /></Link> : <span className="connected-issue-waiting">Waiting for investigation…</span>}
            </article>;
          })}
      </section>
    </main>
  </div>;
}
