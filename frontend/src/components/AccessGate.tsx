import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2000);
    fetch(`${API}/api/config`, { signal: controller.signal }).then((r) => r.json()).then(async (config: { authenticationRequired?: boolean }) => {
      if (!config.authenticationRequired) return 'ready' as const;
      const response = await fetch(`${API}/api/auth/me`, { credentials: 'include', signal: controller.signal });
      return response.ok ? 'ready' as const : 'login' as const;
    }).then((next) => { if (active) setState(next); }).catch(() => { if (active) setState('ready'); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, []);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/api/auth/session`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error('Sign-in failed. Check your access token.');
      setToken(''); setState('ready');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed'); }
    finally { setBusy(false); }
  };
  if (state === 'ready') return children;
  return <main id="main" className="review-page"><h1>TwinOps access</h1>{state === 'checking' ? <p role="status">Checking access…</p> :
    <form className="approval-form" onSubmit={(event) => void login(event)}><p>Sign in with your assigned viewer, investigator, or approver token.</p>
      <label>Access token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>{error && <p role="alert">{error}</p>}
    </form>}</main>;
}
