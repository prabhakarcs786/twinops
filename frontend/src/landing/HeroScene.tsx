import { useEffect, useMemo, useState } from 'react';
import { VERDICT_LABEL, type RunResult } from '../engine/orchestrator.ts';
import { buildTopology } from '../engine/topology.ts';
import { useReducedMotion } from '../lib/hooks.ts';
import { fmtClock } from '../workbench/usePlayback.ts';
import { DEMO_SEED, demoRun } from './demoRun.ts';

const PHASES = ['healthy', 'fault', 'twin', 'experiment', 'challenge', 'verified', 'applied'] as const;
type HeroPhase = (typeof PHASES)[number];

type Callout = { kicker: string; title: string; body: string; tone: string };

/** Every number in the hero comes from a real seeded engine run, computed on load. */
function calloutsFor(run: RunResult): Record<HeroPhase, Callout> {
  const at = (kind: string) => fmtClock(run.events.find((e) => e.kind === kind)?.at ?? 0);
  const failing = run.observation.probes.filter((p) => p.kind === 'journey' && !p.ok);
  const firstTries = run.candidates.filter((c) => c.change.origin !== 'revision');
  const superseded = run.candidates.find((c) => c.decision === 'superseded');
  const revision = run.candidates.find((c) => c.change.parentId === superseded?.change.id);
  const weakness = superseded?.challenges.find((c) => !c.ok && !c.soft);
  const unsafe = run.candidates.find((c) => c.change.origin === 'evaluation_case');
  const letter = (label?: string) => label?.split(' · ')[0] ?? '';
  return {
    healthy: { kicker: '00:00 · demo network', title: 'All journeys green', body: `${run.topology.journeys.length} customer journeys · ${run.topology.nodes.length} nodes · synthetic`, tone: 'ok' },
    fault: { kicker: `${at('fault_injected')} · break`, title: `${failing.map((p) => p.path[0]).join(' and ')} unreachable`, body: `${run.observation.rawEventCount} raw events → ${run.observation.alarms.length} alarms. Fault label sealed.`, tone: 'fail' },
    twin: { kicker: `${at('reproduced')} · reproduce`, title: `Twin slice: ${run.reproduction.slice.length} of ${run.topology.nodes.length} nodes`, body: `${run.reproduction.matched}/${run.reproduction.total} symptoms reproduced from the captured state`, tone: 'twin' },
    experiment: { kicker: `${at('experiment_result')} · experiment`, title: firstTries.map((c) => `${letter(c.change.label)} ${c.restored ? '✓' : '✕'}`).join('  '), body: `${firstTries.length} candidates, each on a fresh copy of the fault`, tone: 'twin' },
    challenge: { kicker: `${at('revised')} · challenge`, title: weakness ? `${letter(superseded?.change.label)} fails ${weakness.label}` : 'Challenges survived', body: revision ? `Revised to ${letter(revision.change.label)}: ${revision.change.label.split(' · ')[1]}` : 'No revision needed', tone: 'warn' },
    verified: { kicker: `${at('gate_verdict')} · proof gate`, title: VERDICT_LABEL[run.verdict], body: `${letter(run.selected?.change.label)} selected · ${letter(unsafe?.change.label)} rejected by ${unsafe?.gates.filter((g) => g.status === 'fail').map((g) => g.id).join(' + ') ?? 'policy'}`, tone: 'ok' },
    applied: { kicker: 'human approved', title: 'Applied to the demo lab', body: `Production writes during diagnosis: ${run.writesDuringDiagnosis}`, tone: 'ok' },
  };
}

export function HeroScene() {
  const reduced = useReducedMotion();
  const topo = useMemo(() => buildTopology('core'), []);
  const [run] = useState(demoRun);
  const callouts = useMemo(() => calloutsFor(run), [run]);
  const BROKEN = run.observation.probes.filter((p) => p.kind === 'journey' && !p.ok).map((p) => p.path[0]);
  const OUT_OF_SLICE = topo.nodes.filter((n) => !run.reproduction.slice.includes(n.id)).map((n) => n.id);
  const warnNode = run.candidates.find((c) => c.decision === 'superseded')?.challenges.find((c) => !c.ok && !c.soft)?.probes.find((p) => !p.ok)?.path[0];
  const focusNode = run.selected?.touched[0];
  const [i, setI] = useState(0);
  const phase: HeroPhase = reduced ? 'verified' : PHASES[i];

  useEffect(() => {
    if (reduced) return;
    const t = window.setTimeout(() => setI((n) => (n + 1) % PHASES.length), i === 0 ? 2600 : 2300);
    return () => window.clearTimeout(t);
  }, [i, reduced]);

  const stage = PHASES.indexOf(phase);
  const prodBroken = stage >= 1 && stage <= 5;
  const twinOn = stage >= 2 && stage <= 6;
  const twinBroken = stage === 2 || stage === 3;
  const callout = callouts[phase];

  const nodeClass = (id: string, plane: 'prod' | 'twin') => {
    if (plane === 'twin' && OUT_OF_SLICE.includes(id)) return 'is-out';
    if (plane === 'prod' && prodBroken && BROKEN.includes(id)) return 'is-fail';
    if (plane === 'twin' && twinBroken && BROKEN.includes(id)) return 'is-fail';
    if (plane === 'twin' && phase === 'challenge' && id === warnNode) return 'is-warn';
    if (plane === 'twin' && phase === 'experiment' && id === focusNode) return 'is-focus';
    return 'is-ok';
  };

  const plane = (kind: 'prod' | 'twin') => (
    <svg viewBox="0 0 560 330" className="plane-svg" aria-hidden="true">
      {topo.links.map((l) => {
        const a = topo.nodes.find((n) => n.id === l.a)!;
        const b = topo.nodes.find((n) => n.id === l.b)!;
        const out = kind === 'twin' && (OUT_OF_SLICE.includes(a.id) || OUT_OF_SLICE.includes(b.id));
        return <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`p-link ${l.backup ? 'is-backup' : ''} ${out ? 'is-out' : ''}`} />;
      })}
      {!reduced &&
        topo.journeys.map((j, k) => {
          const from = topo.nodes.find((n) => n.id === j.from)!;
          const broken = BROKEN.includes(j.from) && (kind === 'prod' ? prodBroken : twinBroken);
          if (kind === 'twin' && (!twinOn || OUT_OF_SLICE.includes(j.from))) return null;
          const d = broken ? `M${from.x},${from.y} L252,168` : `M${from.x},${from.y} L252,168 L404,168 L508,168`;
          return (
            <circle key={`${j.id}-${broken}`} r="5" className={`p-packet ${broken ? 'is-fail' : ''}`}>
              <animateMotion dur={broken ? '1.1s' : '2.4s'} begin={`${k * 0.45}s`} repeatCount="indefinite" path={d} />
            </circle>
          );
        })}
      {topo.nodes.map((n) => (
        <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`p-node ${nodeClass(n.id, kind)}`}>
          <circle r="22" className="p-halo" />
          <circle r="13" className="p-core" />
          <text y={n.role === 'pop' ? 5 : 40} x={n.role === 'pop' ? -30 : 0} textAnchor={n.role === 'pop' ? 'end' : 'middle'}>
            {n.short}
          </text>
        </g>
      ))}
    </svg>
  );

  return (
    <div className={`hero-stage phase-${phase}`} role="img" aria-label="Animated illustration: a production network breaks, an isolated twin reproduces the fault, fixes are tested and challenged in the twin, and only the verified fix is applied after human approval.">
      <div className="hero-scene">
        <div className="plane plane-prod">
          <span className="plane-tag">Production · synthetic demo network</span>
          {plane('prod')}
        </div>
        <div className={`plane plane-twin ${twinOn ? 'is-on' : ''}`}>
          <span className="plane-tag">Digital twin · isolated slice</span>
          {plane('twin')}
        </div>
        {topo.nodes
          .filter((n) => !OUT_OF_SLICE.includes(n.id))
          .map((n) => (
            <span key={n.id} className={`beam ${twinOn ? 'is-on' : ''}`} style={{ left: `${(n.x / 560) * 100}%`, top: `${(n.y / 330) * 100}%` }} />
          ))}
      </div>

      <div className={`callout tone-${callout.tone}`} key={phase}>
        <span className="callout-kicker">{callout.kicker}</span>
        <strong>{callout.title}</strong>
        <span>{callout.body}</span>
      </div>

      <ol className="hero-phases" aria-hidden="true">
        {['Observe', 'Reproduce', 'Experiment', 'Challenge', 'Prove', 'Apply'].map((label, k) => (
          <li key={label} className={k + 1 <= stage ? 'is-on' : ''}>
            {label}
          </li>
        ))}
      </ol>
      <p className="hero-caption">Driven by a real seeded engine run · F1 · seed {DEMO_SEED} · computed in your browser</p>
    </div>
  );
}
