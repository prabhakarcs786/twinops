import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunEvent } from '../engine/types.ts';

/**
 * Paces pre-computed run events for humans. `wall` is real elapsed time while the run progresses
 * (it pauses while waiting for a human); `marks` records the wall time each event became visible.
 */
export function usePlayback(events: RunEvent[], speed: number) {
  const [clock, setClock] = useState(0);
  const [wall, setWall] = useState(0);
  const [marks, setMarks] = useState<Record<number, number>>({});
  const lastAt = events.at(-1)?.at ?? 0;
  const clockRef = useRef(0);
  const wallRef = useRef(0);

  useEffect(() => {
    if (events.length === 0 || !Number.isFinite(speed)) return;
    let prev = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const dt = now - prev;
      prev = now;
      if (clockRef.current >= lastAt) return;
      clockRef.current = Math.min(clockRef.current + dt * speed, lastAt);
      wallRef.current += dt;
      const c = clockRef.current;
      const w = wallRef.current;
      setClock(c);
      setWall(w);
      setMarks((m) => {
        let next = m;
        for (const e of events) {
          if (e.at <= c && next[e.seq] === undefined) {
            if (next === m) next = { ...m };
            next[e.seq] = w;
          }
        }
        return next;
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [events, lastAt, speed]);

  const reset = useCallback(() => {
    clockRef.current = 0;
    wallRef.current = 0;
    setClock(0);
    setWall(0);
    setMarks({});
  }, []);

  const skip = useCallback(() => {
    clockRef.current = lastAt;
    setClock(lastAt);
  }, [lastAt]);

  const effective = Number.isFinite(speed) ? clock : lastAt;
  let index = 0;
  while (index < events.length && events[index].at <= effective) index++;
  return { wall, marks, index, done: events.length > 0 && index === events.length, reset, skip };
}

export const fmtClock = (ms: number) => {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
