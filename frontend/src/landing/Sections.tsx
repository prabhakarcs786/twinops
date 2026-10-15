import { BrainCircuit, Cog, Gavel, Layers, Network, ScanEye, ServerCog, ShieldCheck, UserCheck, Wrench } from 'lucide-react';
import type { CSSProperties } from 'react';
import { StatusChip } from '../components/StatusChip.tsx';
import type { CandidateRecord } from '../engine/types.ts';
import { spotlight } from '../lib/hooks.ts';
import { demoRun, letterOf, nameOf } from './demoRun.ts';

function FixColumn({ record, tone }: { record: CandidateRecord; tone: 'bad' | 'good' }) {
  const neg = record.fixed.find((p) => p.id === 'NEG-1');
  const v6 = record.challenges.find((c) => c.kind === 'dual_stack');
  const gate = (id: string) => record.gates.find((g) => g.id === id)!;
  const rows = [
    { label: 'Affected journeys restored', ok: record.restored, detail: record.restored ? 'all affected journeys succeed' : 'still failing' },
    { label: 'Admin port stays blocked', ok: Boolean(neg?.ok), detail: neg?.detail ?? '' },
    { label: 'IPv6 parity', ok: v6 ? v6.ok : null, detail: v6 ? v6.detail : 'not attacked — earlier gate failed' },
    { label: 'Release policy (G5)', ok: gate('G5').status === 'pass', detail: gate('G5').reason },
    { label: 'Rollback rehearsed (G6)', ok: gate('G6').status === 'pass', detail: gate('G6').reason },
  ];
  return (
    <article className={`fix fix-${tone}`} data-reveal onPointerMove={spotlight}>
      <header>
        <span className="cand-letter">{letterOf(record.change.label)}</span>
        <div>
          <p className="fix-kicker">{record.change.origin === 'evaluation_case' ? 'The tempting fix · evaluation case' : 'The verified fix · revision'}</p>
          <h3>{nameOf(record.change.label)}</h3>
        </div>
      </header>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <StatusChip tone={r.ok === null ? 'skip' : r.ok ? 'ok' : 'fail'}>{r.label}</StatusChip>
            <span>{r.detail}</span>
          </li>
        ))}
      </ul>
      <p className={`fix-stamp ${tone === 'bad' ? 'is-bad' : 'is-good'}`}>{tone === 'bad' ? 'REJECTED' : 'PASS UNDER DEFINED TESTS'}</p>
    </article>
  );
}

export function TemptingFix() {
  const run = demoRun();
  const unsafe = run.candidates.find((c) => c.change.origin === 'evaluation_case')!;
  return (
    <section className="section tempting" aria-labelledby="tempting-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">03 — The moment that matters</p>
          <h2 id="tempting-title">
            Restoring connectivity is not enough <span className="grad-text-warn">if the fix weakens security.</span>
          </h2>
          <p className="lead">Both changes bring customers back. Only one survives the evidence. The unsafe one is a labelled evaluation case — the gate must reject it every time, whoever proposes it.</p>
        </header>
        <div className="fix-grid">
          <FixColumn record={unsafe} tone="bad" />
          <div className="fix-vs" aria-hidden="true">
            vs
          </div>
          <FixColumn record={run.selected!} tone="good" />
        </div>
      </div>
    </section>
  );
}

const GATES = [
  { id: 'G1', name: 'Reproduced', rule: 'Every affected journey and ≥ 90% of symptoms match in the twin.', effect: 'Stop — nothing is trusted without reproduction.' },
  { id: 'G2', name: 'Restores', rule: 'Every affected journey succeeds in the twin after the change.', effect: 'Reject' },
  { id: 'G3', name: 'No regression', rule: 'Unaffected journeys, negative tests and a positive control stay intact.', effect: 'Reject — missing results are not passes.' },
  { id: 'G4', name: 'Survives challenge', rule: 'IPv6 parity, secondary failure, ×3 surge, warm caches, sessions.', effect: 'Revise (≤ 2) or reject' },
  { id: 'G5', name: 'Policy', rule: 'Catalogue actions only, blast radius ≤ 2 nodes, nothing security-weakening.', effect: 'Reject' },
  { id: 'G6', name: 'Rollback', rule: 'Rollback executed in the twin restores the captured state hash.', effect: 'Reject' },
  { id: 'G7', name: 'Soft checks', rule: 'Latency over budget or session impact is surfaced, not hidden.', effect: 'Pass with warnings' },
  { id: 'G8', name: 'Human approval', rule: 'Bound to change hash, run and target state. Drift invalidates it.', effect: 'Apply gateway refuses' },
];

export function ProofGateSection() {
  return (
    <section id="gate" className="section gate-section" aria-labelledby="gate-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">04 — Proof Gate</p>
          <h2 id="gate-title">
            The judge of the AI <span className="grad-text">is not the AI.</span>
          </h2>
          <p className="lead">Deterministic code computes every verdict from structured evidence. Status language is precise: PASS UNDER DEFINED TESTS, PASS WITH WARNINGS, REJECTED, INCONCLUSIVE, ESCALATE. Never “guaranteed safe”.</p>
        </header>
        <ol className="gate-grid">
          {GATES.map((g, i) => (
            <li key={g.id} className="gate-card" data-reveal style={{ '--d': `${i * 60}ms` } as CSSProperties} onPointerMove={spotlight}>
              <span className="gate-card-id">{g.id}</span>
              <h3>{g.name}</h3>
              <p>{g.rule}</p>
              <p className="gate-card-effect">
                <span>On fail</span> {g.effect}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function GenAiSplit() {
  return (
    <section className="section split" aria-labelledby="split-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">05 — Division of labour</p>
          <h2 id="split-title">GenAI reasons. Code decides.</h2>
        </header>
        <div className="split-grid">
          <article className="split-card split-ai" data-reveal onPointerMove={spotlight}>
            <h3>
              <BrainCircuit size={20} aria-hidden="true" /> Where a model adds value
            </h3>
            <ul>
              <li>Correlate evidence and rank root-cause hypotheses</li>
              <li>Choose and parameterise fixes from the typed catalogue</li>
              <li>Pick challenge scenarios against the proposed fix</li>
              <li>Narrate the Proof Pack for the human approver</li>
              <li>Answer questions about a captured investigation with cited evidence</li>
            </ul>
          </article>
          <article className="split-card split-code" data-reveal onPointerMove={spotlight}>
            <h3>
              <Cog size={20} aria-hidden="true" /> Where code stays in charge, on purpose
            </h3>
            <ul>
              <li>Simulate the network, inject faults, measure outcomes</li>
              <li>Validate every action against the catalogue schema</li>
              <li>Run probes and score pass / fail</li>
              <li>Enforce policy and the Proof Gate</li>
              <li>Mint approval tokens and gate every write</li>
            </ul>
          </article>
        </div>
        <p className="split-note" data-reveal>
          <StatusChip tone="info">Cloud Run demo</StatusChip> The deployed workbench is configured for Gemini 2.5 Flash through Vertex AI, with real routing, DNS and TLS in an isolated protocol lab. The animations and evaluation on this overview use the deterministic browser engine. Model calls and runbook fallbacks are recorded in each investigation’s AI trace; the Proof Gate always runs in code.
        </p>
      </div>
    </section>
  );
}

const ARCH = [
  { icon: Network, name: 'Demo network', role: 'Synthetic clients, routers, DNS, TLS gateway, service', boundary: 'Synthetic lab only', tone: 'prod' },
  { icon: ScanEye, name: 'Observation service', role: 'Probes, alarms, changes, logs → hashed snapshot', boundary: 'Read-only adapters', tone: 'neutral' },
  { icon: BrainCircuit, name: 'Diagnosis & challenge roles', role: 'Hypotheses, typed candidates, challenge selection', boundary: 'No write tools, no shell', tone: 'ai' },
  { icon: Layers, name: 'Twin manager', role: 'Pinned topology, captured state, reset per candidate', boundary: 'Isolated twin only', tone: 'twin' },
  { icon: ServerCog, name: 'Experiment runner', role: 'Schema-validated actions, fixed + challenge probes', boundary: 'Twin writes only', tone: 'twin' },
  { icon: Gavel, name: 'Proof Gate', role: 'G1–G7 from evidence and policy', boundary: 'Deterministic · model cannot edit', tone: 'gate' },
  { icon: UserCheck, name: 'Review & approval', role: 'Diff, rollback, untested conditions, sign-off', boundary: 'Bound to hash + state', tone: 'gate' },
  { icon: Wrench, name: 'Apply gateway', role: 'Drift check, apply once, post-check, rollback', boundary: 'Only write path · token required', tone: 'prod' },
];

export function Architecture() {
  return (
    <section id="architecture" className="section arch" aria-labelledby="arch-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">06 — Architecture &amp; trust boundaries</p>
          <h2 id="arch-title">
            Agents read the world. <span className="grad-text">They only write to a twin.</span>
          </h2>
          <p className="lead">The planner is separated from anything that can execute. A small, auditable apply gateway is the only path back to the network — and it opens only after a human decision.</p>
        </header>
        <ol className="arch-flow">
          {ARCH.map((c, i) => (
            <li key={c.name} className={`arch-node tone-${c.tone}`} data-reveal style={{ '--d': `${i * 70}ms` } as CSSProperties}>
              <span className="arch-step">{i + 1}</span>
              <c.icon size={20} aria-hidden="true" />
              <h3>{c.name}</h3>
              <p>{c.role}</p>
              <p className="arch-boundary">
                <ShieldCheck size={13} aria-hidden="true" /> {c.boundary}
              </p>
            </li>
          ))}
        </ol>
        <ul className="arch-legend" aria-label="Legend">
          <li className="tone-prod">Network-touching path</li>
          <li className="tone-ai">Reasoning (no write access)</li>
          <li className="tone-twin">Isolated twin</li>
          <li className="tone-gate">Deterministic gate &amp; human</li>
        </ul>
      </div>
    </section>
  );
}

export function Horizon() {
  const items = [
    { h: 'H1 · now', title: 'Protocol lab on Google Cloud', body: 'TwinOps and Metro Network are deployed on Cloud Run with separate lab networks for the application and its twin. FRR routing, CoreDNS and nginx TLS run in Linux network namespaces. Synthetic scenarios cover routing, DNS and certificate faults.' },
    { h: 'H2 · pilot', title: 'Shadow mode on real telemetry', body: 'Read-only adapters against an approved non-production estate. Scenario packs for cloud infrastructure, Kubernetes and CI/CD, each with its own typed catalogue.' },
    { h: 'H3 · platform', title: 'ProofGate for any agent', body: 'Any AI agent’s action must pass reproduce → experiment → challenge → policy → approval before it executes. Verification as a product, not a feature.' },
  ];
  return (
    <section className="section horizon" aria-labelledby="horizon-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">08 — Horizon</p>
          <h2 id="horizon-title">One loop. Many domains.</h2>
        </header>
        <ol className="horizon-grid">
          {items.map((it, i) => (
            <li key={it.h} className="horizon-card" data-reveal style={{ '--d': `${i * 90}ms` } as CSSProperties} onPointerMove={spotlight}>
              <span className="horizon-h">{it.h}</span>
              <h3>{it.title}</h3>
              <p>{it.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Honest() {
  return (
    <section className="section honest" aria-labelledby="honest-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">09 — Honest by design</p>
          <h2 id="honest-title">Evidence under tested scenarios. Not a guarantee.</h2>
        </header>
        <div className="honest-grid">
          <article data-reveal>
            <h3>What a TwinOps verdict shows</h3>
            <ul className="honest-yes">
              <li>The fix restored the affected journeys in a twin that reproduced the fault</li>
              <li>It survived the defined negative tests and challenges</li>
              <li>It is policy-compliant and its rollback was rehearsed</li>
              <li>A named human approved that exact change against that exact state</li>
            </ul>
          </article>
          <article data-reveal>
            <h3>What it never claims</h3>
            <ul className="honest-no">
              <li>That a change is safe in every production condition</li>
              <li>A faithful clone of a real carrier network</li>
              <li>Autonomous approval — a human always decides</li>
              <li>Invented customer counts or savings — only measured lab results</li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}
