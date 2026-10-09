import { ArrowLeft, ArrowRight, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Brand } from '../components/Brand.tsx';
import { Link } from '../lib/router.tsx';
import '../styles/deck.css';

/** Pitch deck: 10 slides, keyboard navigable, prints to a 16:9 PDF (one slide per page). Every number is measured. */

interface Slide {
  title: string;
  body: ReactNode;
}

const LOOP = ['Observe', 'Diagnose', 'Reproduce in twin', 'Experiment', 'Challenge', 'Proof Gate', 'Human approval', 'Apply'];

const LAB_RUNS = [
  { fault: 'F1 · Route misconfiguration', verdict: 'PASS UNDER DEFINED TESTS', tone: 'ok', s: '58.5', note: 'B superseded by B′ after a real IPv6 timeout' },
  { fault: 'F2 · DNS failure', verdict: 'PASS UNDER DEFINED TESTS', tone: 'ok', s: '41.1', note: 'C superseded by C′: warm resolver cache still stale' },
  { fault: 'F3 · Certificate expiry', verdict: 'PASS WITH WARNINGS', tone: 'warn', s: '34.4', note: 'reload drains long-lived sessions (G7 warning)' },
  { fault: 'F0 · Link flap (unsupported)', verdict: 'INCONCLUSIVE', tone: 'fail', s: '18.3', note: 'not reproducible in the twin, so no fix proposed' },
];

const CONTROLS = [
  'Target drifts after the snapshot → approval invalidated',
  'Approval hash ≠ tested change → refused',
  'Operator rejects → zero writes',
  'Planner emits an off-catalogue action → never executed',
  'Unsupported physical fault → INCONCLUSIVE, zero experiments',
  'Instruction-like text in device logs → treated as data',
];

const SLIDES: Slide[] = [
  {
    title: 'What if AI had to prove its fix?',
    body: (
      <div className="d-hero">
        <Brand />
        <h2>
          What if AI had to <span className="grad-text">prove its fix</span> before touching production?
        </h2>
        <p className="d-lead">TwinOps reproduces an incident in an isolated digital twin, tests competing fixes there, attacks its own best answer and hands a human only the change that survived the evidence.</p>
        <p className="d-kicker">Design principle: don’t trust the AI’s reasoning. Make it prove the change.</p>
      </div>
    ),
  },
  {
    title: 'The problem: fixes that sound right',
    body: (
      <div className="d-cols">
        <div>
          <p className="d-lead">Under incident pressure, the first fix that restores service wins, whether or not it is safe.</p>
          <ul className="d-list">
            <li>
              <strong>Tempting fixes</strong> such as disabling a filter, pinning hosts or turning off TLS validation make the symptom go away and open new risk.
            </li>
            <li>
              <strong>Change review is re-investigation.</strong> Approvers redo the diagnosis because there is no shared evidence.
            </li>
            <li>
              <strong>AI makes it faster, not safer.</strong> A fluent explanation is not evidence, and a model can be steered by text in logs.
            </li>
          </ul>
        </div>
        <div className="d-card d-card-warn">
          <p className="d-eyebrow">Real example from our lab</p>
          <p>
            Disabling the edge filter restores every customer journey <em>and</em> exposes the management console to an untrusted edge.
          </p>
          <p className="d-mono">NEG-1 admin console 10.99.0.10:8443 answered HTTP from untrusted 10.23.0.1</p>
        </div>
      </div>
    ),
  },
  {
    title: 'The TwinOps loop',
    body: (
      <>
        <ol className="d-loop">
          {LOOP.map((step, i) => (
            <li key={step} className={i >= 6 ? 'is-human' : i >= 2 ? 'is-twin' : ''}>
              <span>{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
        <div className="d-cols d-cols-3">
          <div className="d-card">
            <p className="d-eyebrow">Allowed to be wrong safely</p>
            <p>Every candidate is applied to a twin of the affected slice and measured with real probes. Failed fixes cost nothing.</p>
          </div>
          <div className="d-card">
            <p className="d-eyebrow">Attacks its own answer</p>
            <p>The challenge role tries IPv6 parity, a secondary node failure, warm caches and session continuity against the best fix.</p>
          </div>
          <div className="d-card">
            <p className="d-eyebrow">Production stays read-only</p>
            <p>The only write path is an apply gateway that needs a human approval bound to the change hash and the target-state hash.</p>
          </div>
        </div>
      </>
    ),
  },
  {
    title: 'Live demo: one real run on the emulated lab',
    body: (
      <div className="d-cols">
        <ol className="d-run">
          <li className="t-ok">Fault reproduced in the twin: 10/10 symptoms match</li>
          <li className="t-fail">A · Restart routing → REJECTED: J1, J3 still fail (TCP timeout, curl exit 28)</li>
          <li className="t-warn">B · Roll back prefix-list → IPv6 challenge fails → superseded</li>
          <li className="t-ok">B′ · Remove EDGE-IN seq 30 only → 7/7 automated gates pass</li>
          <li className="t-fail">U · Disable the filter (evaluation case) → REJECTED: admin console exposed</li>
          <li className="t-ok">Human approves the exact hash → applied → 11 real post-checks pass</li>
        </ol>
        <div className="d-stats">
          <div>
            <span className="d-num">58.5 s</span>
            <span>server compute to verdict (FRR, CoreDNS, nginx in Containerlab)</span>
          </div>
          <div>
            <span className="d-num">0</span>
            <span>production writes during diagnosis</span>
          </div>
          <div>
            <span className="d-num">2</span>
            <span>unsafe or insufficient fixes rejected with evidence</span>
          </div>
          <Link to="/workbench" className="btn btn-primary d-noprint">
            Try it: break the network <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
    ),
  },
  {
    title: 'Architecture',
    body: (
      <div className="d-arch">
        <div className="d-arch-row">
          <div className="d-box">Web workbench · React<small>SSE event stream, evidence tabs, approval dialog</small></div>
          <div className="d-arrow" aria-hidden="true">⇄</div>
          <div className="d-box d-box-strong">FastAPI on Cloud Run<small>incidents · SSE · decisions · Proof Pack export · CSP, rate limit, operator auth</small></div>
        </div>
        <div className="d-arch-grid">
          <div className="d-box d-ai">Planner<small>Gemini (structured output) with deterministic runbook fallback</small></div>
          <div className="d-box d-twin">Twin backend<small>model twin (Cloud Run) · Containerlab lab: FRR BGP, CoreDNS, nginx TLS</small></div>
          <div className="d-box d-ok">Proof Gate G1–G8<small>deterministic code: reproduction, restore, regression, challenges, policy, rollback, latency, human</small></div>
          <div className="d-box d-prod">Apply gateway<small>single write path · approval token bound to change + state hash · post-checks · auto-rollback</small></div>
        </div>
        <p className="d-foot">Same event and evidence model in the browser engine, the Python engine and the lab, checked by 40 parity cases.</p>
      </div>
    ),
  },
  {
    title: 'Where Gemini is used, and why code does the rest',
    body: (
      <div className="d-cols">
        <div className="d-card d-card-ai">
          <p className="d-eyebrow">Gemini does the reasoning</p>
          <ul className="d-list">
            <li>Ranked hypotheses that cite evidence IDs (JSON schema)</li>
            <li>Fix proposals from a typed action catalogue</li>
            <li>Extra challenge ideas against its own best fix</li>
            <li>Approver briefing, labelled non-authoritative</li>
          </ul>
        </div>
        <div className="d-card d-card-ok">
          <p className="d-eyebrow">Code does the judging</p>
          <ul className="d-list">
            <li>Twin, probes, gates and policy are deterministic</li>
            <li>Every model output is schema-validated and evidence-checked</li>
            <li>Device logs are fenced as untrusted data</li>
            <li>Call budget, then runbook fallback; record and replay for audits</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    title: 'Evidence: evaluation harness',
    body: (
      <div className="d-cols">
        <div>
          <table className="d-table">
            <caption>Emulated lab, one run per fault (laptop, Docker Desktop)</caption>
            <thead>
              <tr>
                <th scope="col">Fault</th>
                <th scope="col">Verdict</th>
                <th scope="col">Compute</th>
              </tr>
            </thead>
            <tbody>
              {LAB_RUNS.map((r) => (
                <tr key={r.fault}>
                  <th scope="row">
                    {r.fault}
                    <small>{r.note}</small>
                  </th>
                  <td className={`t-${r.tone}`}>{r.verdict}</td>
                  <td className="d-mono">{r.s} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="d-stats d-stats-row">
            <div>
              <span className="d-num">40</span>
              <span>seeded incidents (model twin)</span>
            </div>
            <div>
              <span className="d-num">0</span>
              <span>unsafe fixes passed</span>
            </div>
            <div>
              <span className="d-num">6/6</span>
              <span>adverse controls held</span>
            </div>
          </div>
          <ul className="d-list d-small">
            {CONTROLS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="d-foot">
            Diagnosis accuracy shown here is the runbook baseline. The Gemini planner runs through the same harness: <code>python -m twinops.evaluation --planner llm</code>
          </p>
        </div>
      </div>
    ),
  },
  {
    title: 'Impact on enterprise operations work',
    body: (
      <div className="d-cols d-cols-3">
        <div className="d-card">
          <p className="d-eyebrow">On-call engineer</p>
          <p>Starts from a reproduced fault and tested candidates instead of a blank terminal. The tempting fix is rejected before anyone tries it.</p>
        </div>
        <div className="d-card">
          <p className="d-eyebrow">Change approver</p>
          <p>Reviews a Proof Pack covering evidence, diff, rollback rehearsal and untested conditions, then approves a hash rather than a story.</p>
        </div>
        <div className="d-card">
          <p className="d-eyebrow">Organisation</p>
          <p>Every incident leaves a replayable evidence bundle, so knowledge stops living in one person’s head.</p>
        </div>
        <p className="d-foot d-span">
          Pilot metrics to measure (no invented baselines): time from alarm to verified fix · change failure rate · approval review time · share of AI proposals rejected by the gate.
        </p>
      </div>
    ),
  },
  {
    title: 'Scalability: packs and twin backends',
    body: (
      <div className="d-cols">
        <div>
          <ul className="d-list">
            <li>
              <strong>Scenario packs</strong>: regional telecom core and hybrid enterprise today. The topology, journeys and fault catalogue are data.
            </li>
            <li>
              <strong>Twin backends</strong> behind one protocol: an in-process model twin, then a Containerlab lab with real routing, DNS and TLS, then Kubernetes (kind), cloud-config sandboxes and CI/CD.
            </li>
            <li>
              <strong>Planner providers</strong>: Gemini API, Vertex AI, any OpenAI-compatible endpoint, or replay. The planner can change without touching the Proof Gate.
            </li>
          </ul>
        </div>
        <div className="d-card">
          <p className="d-eyebrow">Honest limits today</p>
          <ul className="d-list d-small">
            <li>Incident state is in memory, so the service runs as one instance; multi-instance needs a shared store.</li>
            <li>Surge and long-lived session behaviour are listed as untested in every Proof Pack.</li>
            <li>The lab is synthetic. Production would start in read-only shadow mode.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    title: 'Roadmap and ask',
    body: (
      <div className="d-cols">
        <div>
          <ol className="d-list d-num-list">
            <li>Incident memory: past fixes are retested on today’s twin, never reused blindly</li>
            <li>Policy as code (OPA) and real telemetry (Prometheus, OpenTelemetry)</li>
            <li>Read-only shadow mode next to a real NOC: verdicts recorded, nothing applied</li>
          </ol>
          <p className="d-lead">
            <strong>Ask:</strong> one operations team, an approved LLM endpoint and a lab slice for a four-week shadow pilot.
          </p>
        </div>
        <blockquote className="d-quote">
          “The AI isn’t impressive because it knew the answer. It’s impressive because it was allowed to be wrong safely until it could prove one.”
        </blockquote>
      </div>
    ),
  },
];

const clamp = (n: number) => Math.min(SLIDES.length - 1, Math.max(0, n));
const fromHash = () => clamp((Number.parseInt(window.location.hash.slice(1), 10) || 1) - 1);

export function Deck() {
  const [index, setIndex] = useState(fromHash);

  useEffect(() => {
    window.history.replaceState(null, '', `#${index + 1}`);
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('button, a, input, select, textarea')) {
        if (e.key === ' ' || e.key === 'Enter') return;
      }
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) setIndex((i) => clamp(i + 1));
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) setIndex((i) => clamp(i - 1));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(SLIDES.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="deck">
      <main id="main" className="deck-stage" aria-roledescription="carousel" aria-label="TwinOps pitch deck">
        {SLIDES.map((slide, i) => (
          <section key={slide.title} className="slide" hidden={i !== index} aria-roledescription="slide" aria-label={`${i + 1} of ${SLIDES.length}: ${slide.title}`}>
            {i > 0 && (
              <header className="slide-head">
                <p className="d-eyebrow">
                  {String(i + 1).padStart(2, '0')} / {SLIDES.length}
                </p>
                <h1>{slide.title}</h1>
              </header>
            )}
            {i === 0 && <h1 className="sr-only">{slide.title}</h1>}
            <div className="slide-body">{slide.body}</div>
          </section>
        ))}
      </main>
      <nav className="deck-nav" aria-label="Slides">
        <Link to="/" className="btn btn-ghost btn-sm">
          Overview
        </Link>
        <button type="button" className="icon-btn" onClick={() => setIndex((i) => clamp(i - 1))} disabled={index === 0} aria-label="Previous slide">
          <ArrowLeft size={18} />
        </button>
        <span className="deck-count" aria-live="polite">
          {index + 1} / {SLIDES.length}
        </span>
        <button type="button" className="icon-btn" onClick={() => setIndex((i) => clamp(i + 1))} disabled={index === SLIDES.length - 1} aria-label="Next slide">
          <ArrowRight size={18} />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}>
          <Printer size={15} aria-hidden="true" /> Save as PDF
        </button>
      </nav>
    </div>
  );
}
