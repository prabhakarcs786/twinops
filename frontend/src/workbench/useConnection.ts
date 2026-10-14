import { useEffect, useState } from 'react';
import { fetchConnection, type NetworkConnection } from '../api/live.ts';

/** The workbench and applications page share one measured connection contract. */
export function useConnection(enabled = true) {
  const [connection, setConnection] = useState<NetworkConnection>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await fetchConnection(controller.signal);
        if (!stopped) { setConnection(data); setError(''); }
      } catch {
        if (!stopped) setError('Connection unavailable. Measurements may be stale; retrying automatically…');
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [enabled]);
  return { connection: enabled ? connection : undefined, error: enabled ? error : '', setConnection };
}
