import { useEffect, useState } from 'react';
import { ArrowUpRight, Radio, Server, ShieldCheck } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { Link } from '../lib/router.tsx';
import '../styles/connections.css';

interface Issue { id: string; title: string; status: string; incidentId: string | null; detectedAt: number; investigationStatus?: string }
interface Connection { configured: boolean; connected: boolean; ready?: boolean; name?: string; detail?: string; url?: string; checkedAt?: number; recoveryRequired?: boolean; issues: Issue[] }
export function Connections({ theme, onToggleTheme }: { theme: 'dark' | 'light'; onToggleTheme: () => void }) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/api/connections', { signal: controller.signal });
        if (!response.ok) throw new Error('TwinOps backend is unavailable');
        const data = await response.json() as Connection;
        if (!stopped) { setConnection(data); setError(''); }
      } catch { if (!stopped) setError('Connection to TwinOps lost. Retrying automatically…'); }
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, []);
  const live = !error && connection?.connected && connection.ready;
  return <div className="connections-page">
    <SiteHeader variant="app" theme={theme} onToggleTheme={onToggleTheme} />
    <main id="main" className="connections-main" tabIndex={-1}>
      <p className="eyebrow">Connected applications</p>
      <h1>Observe the issue.<br /><span className="grad-text">Prove the recovery.</span></h1>
      <p className="connections-lede">Your applications own their live state. TwinOps investigates new issues, tests fixes in an isolated twin and brings you the evidence for approval.</p>
      {error && <p role="alert" className="connection-alert">{error}</p>}
      <section className="connection-card" aria-label="Metro Network connection">
        <div className="connection-app-icon"><Server size={30} /></div>
        <div className="connection-app-info"><p className="eyebrow">LOCAL NETWORK OPERATIONS</p><h2>Metro Network</h2><p>{connection?.detail || 'Connecting to the local application…'}</p>
          {connection?.checkedAt && <small>Last service measurement: {new Date(connection.checkedAt * 1000).toLocaleTimeString()}</small>}
        </div>
        <div className="connection-card-actions"><span className={`connection-badge ${live ? 'is-live' : ''}`}><Radio size={14} /> {live ? 'Monitoring' : connection?.configured === false ? 'Not configured' : 'Unavailable'}</span>
          {connection?.url && <a className="btn btn-ghost btn-sm" href={connection.url} target="_blank" rel="noreferrer">Open application <ArrowUpRight size={15} /></a>}
        </div>
      </section>
      {connection?.configured === false && <p className="connection-alert">Start the connected demo with <code>npm run dev:connected</code> to run both applications and the real network lab.</p>}
      {connection?.recoveryRequired && <p role="alert" className="connection-alert">The network requires operator recovery. Further changes are blocked.</p>}
      <div className="connections-explainer"><span><Radio size={17} /> Automatic issue detection</span><span><Server size={17} /> Isolated Containerlab twin</span><span><ShieldCheck size={17} /> Approval before live changes</span></div>
      <section className="connected-issues"><div className="connected-section-heading"><h2>Detected incidents</h2><span>{connection?.issues.length ?? 0} recorded</span></div>
        {!connection?.issues.length ? <div className="connections-empty"><Radio size={32} /><h3>{live ? 'Watching for new service issues' : 'Waiting for the network application'}</h3><p>Introduce a fault in Metro Network. TwinOps will detect it automatically and start gathering evidence here.</p></div> :
          connection.issues.map((issue) => <article className="connected-issue" key={issue.id}><div><span className="eyebrow">{issue.status === 'resolved' ? 'RECOVERY VERIFIED' : issue.status === 'reset' ? 'SCENARIO RESET BY OPERATOR' : 'SERVICE DISRUPTION'}</span><h3>{issue.title}</h3><p>{new Date(issue.detectedAt * 1000).toLocaleString()} · {issue.investigationStatus === 'finished' ? 'Investigation finished' : issue.incidentId ? 'Investigation created' : 'Detection pending'}</p></div>
            {issue.incidentId ? <Link className="btn btn-primary btn-sm" to={`/workbench?incident=${encodeURIComponent(issue.incidentId)}`}>Open investigation <ArrowUpRight size={15} /></Link> : <span>Waiting for investigation…</span>}
          </article>)}
      </section>
    </main>
  </div>;
}
