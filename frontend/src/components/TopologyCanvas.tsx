import { Globe, Lock, Router, Server, ShieldCheck, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { NodeRole, ProbeResult, TopoLink, Topology } from '../engine/types.ts';

type Pt = [number, number];

const CURVES: Record<string, Pt> = { L6: [26, 168], L8: [250, 292] };

const ROLE_ICON: Record<NodeRole, typeof Router> = {
  pop: Waypoints,
  core: Router,
  dns: Globe,
  gateway: ShieldCheck,
  service: Server,
};

function linkPoints(topo: Topology, link: TopoLink, from: string): Pt[] {
  const a = topo.nodes.find((n) => n.id === link.a)!;
  const b = topo.nodes.find((n) => n.id === link.b)!;
  const ctrl = CURVES[link.id];
  let pts: Pt[];
  if (ctrl) {
    pts = Array.from({ length: 17 }, (_, i) => {
      const t = i / 16;
      const u = 1 - t;
      return [u * u * a.x + 2 * u * t * ctrl[0] + t * t * b.x, u * u * a.y + 2 * u * t * ctrl[1] + t * t * b.y] as Pt;
    });
  } else {
    pts = [
      [a.x, a.y],
      [b.x, b.y],
    ];
  }
  return from === link.a ? pts : pts.reverse();
}

function linkD(topo: Topology, link: TopoLink) {
  const a = topo.nodes.find((n) => n.id === link.a)!;
  const b = topo.nodes.find((n) => n.id === link.b)!;
  const ctrl = CURVES[link.id];
  return ctrl ? `M${a.x},${a.y} Q${ctrl[0]},${ctrl[1]} ${b.x},${b.y}` : `M${a.x},${a.y} L${b.x},${b.y}`;
}

function pathPoints(topo: Topology, path: string[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const link = topo.links.find((l) => (l.a === path[i] && l.b === path[i + 1]) || (l.b === path[i] && l.a === path[i + 1]));
    if (!link) continue;
    const seg = linkPoints(topo, link, path[i]);
    pts.push(...(pts.length ? seg.slice(1) : seg));
  }
  if (pts.length === 0) {
    const n = topo.nodes.find((x) => x.id === path[0]);
    if (n) pts.push([n.x, n.y]);
  }
  return pts;
}

function Packet({ points, ok, delay }: { points: Pt[]; ok: boolean; delay: number }) {
  const ref = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || points.length < 2) return;
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    const total = lengths.at(-1)!;
    const duration = Math.max(700, total * 5.5);
    const cycle = duration + (ok ? 500 : 1100);
    const start = performance.now() + delay;
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed < 0) {
        el.setAttribute('opacity', '0');
      } else {
        const local = elapsed % cycle;
        const t = Math.min(local / duration, 1);
        const d = t * total;
        let i = 1;
        while (i < lengths.length - 1 && lengths[i] < d) i++;
        const seg = lengths[i] - lengths[i - 1] || 1;
        const f = (d - lengths[i - 1]) / seg;
        el.setAttribute('cx', String(points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f));
        el.setAttribute('cy', String(points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f));
        el.setAttribute('opacity', t >= 1 ? (ok ? '0' : String(Math.max(0, 1 - (local - duration) / 900))) : '1');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [points, ok, delay]);
  return <circle ref={ref} r={ok ? 3.4 : 4} className={`pkt ${ok ? 'pkt-ok' : 'pkt-fail'}`} opacity="0" />;
}

export interface TopologyCanvasProps {
  topo: Topology;
  variant: 'prod' | 'twin';
  probes: Record<string, ProbeResult>;
  alarmNodes?: string[];
  slice?: string[] | null;
  focus?: string[];
  failedNodes?: string[];
  animate: boolean;
  label: string;
}

export function TopologyCanvas({ topo, variant, probes, alarmNodes = [], slice, focus = [], failedNodes = [], animate, label }: TopologyCanvasProps) {
  const inSlice = (id: string) => !slice || slice.includes(id);
  const journeyPaths = useMemo(
    () =>
      Object.values(probes)
        .filter((p) => p.path.length > 1 || !p.ok)
        .map((p) => ({ probe: p, pts: pathPoints(topo, p.path) })),
    [probes, topo],
  );
  const failedAt = new Set(Object.values(probes).filter((p) => !p.ok && p.failedAt).map((p) => p.failedAt!));
  const nodeTone = (id: string) => {
    if (failedNodes.includes(id)) return 'down';
    const journeys = Object.values(probes).filter((p) => p.path[0] === id);
    if (journeys.some((p) => !p.ok)) return 'fail';
    if (failedAt.has(id)) return 'fail';
    if (alarmNodes.includes(id) && variant === 'prod') return 'warn';
    return 'ok';
  };

  return (
    <svg className={`topo topo-${variant}`} viewBox="0 0 560 330" role="img" aria-label={label}>
      <defs>
        <pattern id={`dots-${variant}`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" className="topo-dot" />
        </pattern>
      </defs>
      <rect width="560" height="330" fill={`url(#dots-${variant})`} />

      <g className="topo-links">
        {topo.links.map((link) => (
          <path
            key={link.id}
            d={linkD(topo, link)}
            className={`topo-link ${link.backup ? 'is-backup' : ''} ${inSlice(link.a) && inSlice(link.b) ? '' : 'is-out'}`}
          />
        ))}
      </g>

      <g className="topo-journeys">
        {journeyPaths.map(({ probe, pts }) => (
          <polyline key={`${probe.id}-${probe.ok}-${probe.path.join('')}`} points={pts.map((p) => p.join(',')).join(' ')} className={`topo-journey ${probe.ok ? 'is-ok' : 'is-fail'}`} />
        ))}
      </g>

      {animate && (
        <g className="topo-packets">
          {journeyPaths.map(({ probe, pts }, i) => (
            <Packet key={`${probe.id}-${probe.ok}-${probe.path.join('')}`} points={pts} ok={probe.ok} delay={i * 260} />
          ))}
        </g>
      )}

      <g className="topo-nodes">
        {topo.nodes.map((node) => {
          const Icon = ROLE_ICON[node.role];
          const tone = nodeTone(node.id);
          const out = !inSlice(node.id);
          return (
            <g key={node.id} transform={`translate(${node.x},${node.y})`} className={`topo-node tone-${tone} ${out ? 'is-out' : ''} ${focus.includes(node.id) ? 'is-focus' : ''}`}>
              {tone === 'fail' && !out && <circle r="26" className="topo-pulse" />}
              {focus.includes(node.id) && <circle r="27" className="topo-focus" />}
              <circle r="19" className="topo-node-bg" />
              <Icon x={-9} y={-9} width={18} height={18} strokeWidth={2} className="topo-icon" aria-hidden="true" />
              {tone === 'down' && <path d="M-8,-8 L8,8 M8,-8 L-8,8" className="topo-x" />}
              <text y={node.role === 'pop' ? 4 : 35} x={node.role === 'pop' ? -28 : 0} textAnchor={node.role === 'pop' ? 'end' : 'middle'} className="topo-label">
                {node.short}
              </text>
            </g>
          );
        })}
      </g>

      <g transform="translate(300,118)" className="topo-mgmt">
        <rect x="-4" y="-13" width="78" height="18" rx="9" />
        <Lock x={2} y={-10} width={11} height={11} strokeWidth={2.4} aria-hidden="true" />
        <text x={17} y={0}>MGMT /16</text>
      </g>
    </svg>
  );
}
