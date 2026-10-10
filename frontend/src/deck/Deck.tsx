import { ArrowLeft, ArrowRight, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Brand } from '../components/Brand.tsx';
import { fetchReports, type EvaluationReport } from '../api/live.ts';
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

function MeasuredEvidence() {
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    fetchReports().then((items) => { if (active) setReports(items.sort((first, second) => second.generatedAt.localeCompare(first.generatedAt))); })
      .catch(() => undefined).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);
  const latest = reports.find((report) => report.planner.kind === 'llm');
  const baseline = latest && reports.find((report) => report.planner.kind === 'runbook' && report.pack === latest.pack
    && report.suiteVersion === latest.suiteVersion && report.seeds === latest.seeds && report.startSeed === latest.startSeed
    && (report.variant ?? 'standard') === (latest.variant ?? 'standard'));
  const paired = latest && baseline;
  return <div className="d-measured" data-evidence-ready={loaded}>
    {paired ? <>
      <p className="d-eyebrow">{latest.planner.provider} · {latest.planner.model} vs runbook</p>
      <table className="d-table"><caption>{latest.pack} · {latest.variant ?? 'standard'} · seeds {latest.startSeed}–{latest.startSeed + latest.seeds - 1}</caption>
        <thead><tr><th scope="col">Fault</th><th scope="col">Runbook</th><th scope="col">Model, no fallback</th><th scope="col">Unsafe pass</th></tr></thead>
        <tbody>{Object.entries(latest.byFault).map(([fault, row]) => <tr key={fault}><th scope="row">{fault.replaceAll('_', ' ')}</th><td>{baseline.byFault[fault]?.verdictOk ?? '-'}/{baseline.byFault[fault]?.runs ?? '-'}</td><td>{row.fallbackFreeSuccess ?? '-'}/{row.runs}</td><td>{row.unsafePassed}</td></tr>)}</tbody>
      </table>
      <p className="d-foot">{latest.planner.version} · {latest.suiteVersion} · measured {new Date(latest.generatedAt).toLocaleDateString()}. {latest.seeds < 10 ? 'Smoke sample only, not a reliability estimate.' : 'Synthetic scenarios, not production reliability.'} Memory disabled in paired evaluations.</p>
    </> : <>
      <p className="d-eyebrow">Paired evidence not loaded</p>
      <p className="d-foot">No model advantage is claimed without comparable reports. Saved comparisons are available in the connected workbench.</p>
    </>}
    <ul className="d-list d-small">{CONTROLS.slice(0, 4).map((control) => <li key={control}>{control}</li>)}</ul>
  </div>;
}

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
              <strong>AI suggestions are not proof.</strong> A fluent explanation is not evidence, and a model can be steered by text in logs.
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
            <p>Candidates are tested on an isolated twin. Probes are simulated in the model twin and real network traffic in Containerlab. Failures remain outside the target network.</p>
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
            <span>historical runbook smoke, 9 Oct 2026 · FRR, CoreDNS, nginx in Containerlab</span>
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
          <div className="d-box d-box-strong">FastAPI + SSE<small>Cloud Run packaging; deployment unverified · incident evidence in local SQLite</small></div>
        </div>
        <div className="d-arch-grid">
          <div className="d-box d-ai">Planner<small>Ollama tested locally · Gemini/Vertex adapters · bounded feedback and runbook fallback</small></div>
          <div className="d-box d-twin">Twin backend<small>model twin (Cloud Run) · Containerlab lab: FRR BGP, CoreDNS, nginx TLS</small></div>
          <div className="d-box d-ok">Proof Gate G1–G8<small>deterministic code: reproduction, restore, regression, challenges, policy, rollback, latency, human</small></div>
          <div className="d-box d-prod">Apply gateway<small>approval bound to change + state · post-checks · verified rollback or operator recovery</small></div>
        </div>
        <p className="d-foot">Same event and evidence model in the browser engine, the Python engine and the lab, checked by 40 parity cases.</p>
      </div>
    ),
  },
  {
    title: 'AI proposes. Evidence decides.',
    body: (
      <div className="d-cols">
        <div className="d-card d-card-ai">
          <p className="d-eyebrow">Bounded model reasoning</p>
          <ul className="d-list">
            <li>Ranked hypotheses that cite evidence IDs (JSON schema)</li>
            <li>Fix proposals from a typed action catalogue</li>
            <li>Failed tests guide a bounded repair and fresh retest</li>
            <li>Approver briefing, labelled non-authoritative</li>
          </ul>
        </div>
        <div className="d-card d-card-ok">
          <p className="d-eyebrow">Code does the judging</p>
          <ul className="d-list">
            <li>Twin, probes, gates and policy are deterministic</li>
            <li>Catalogue actions and source IDs checked; hypotheses remain interpretations</li>
            <li>Device logs are fenced as untrusted data</li>
            <li>Historical fixes retested; past approval never reused</li>
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
            <caption>Historical runbook lab smoke · 9 Oct 2026 · one run per fault</caption>
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
        <MeasuredEvidence />
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
          <p>Past successful changes become candidates for fresh verification. A similar incident never imports an old approval.</p>
        </div>
        <p className="d-foot d-span">
          A read-only review trial records time and gate agreement for the same candidate with raw evidence and with its Proof Pack. Human trials are pending; no time savings are claimed.
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
            <li>Local SQLite preserves evidence. Cloud Run instance replacement needs external storage; one service process owns a target.</li>
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
            <li>Now built: incident-memory retesting, changed-state challenges and anonymous review trials</li>
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
