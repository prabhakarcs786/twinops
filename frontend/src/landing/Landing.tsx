import { ArrowRight, Clock3, Flame, MessageSquareWarning, Zap } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Brand } from '../components/Brand.tsx';
import { SiteHeader } from '../components/SiteHeader.tsx';
import { Link } from '../lib/router.tsx';
import { spotlight, useReveal } from '../lib/hooks.ts';
import { demoRun } from './demoRun.ts';
import { EvaluationLab } from './EvaluationLab.tsx';
import { HeroScene } from './HeroScene.tsx';
import { Architecture, GenAiSplit, Honest, Horizon, ProofGateSection, TemptingFix } from './Sections.tsx';
import { Story } from './Story.tsx';

interface Props {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function Hero() {
  const run = demoRun();
  const stats = [
    { value: String(run.writesDuringDiagnosis), label: 'production writes during diagnosis' },
    { value: '8', label: 'proof gates, deterministic' },
    { value: '3', label: 'fault families + 1 unsupported control' },
    { value: '1', label: 'human decision, bound to a hash' },
  ];
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden="true">
        <span className="aurora a1" />
        <span className="aurora a2" />
        <span className="aurora a3" />
        <span className="hero-grid-bg" />
      </div>
      <div className="container hero-layout">
        <div className="hero-copy">
          <p className="pill">
            <span className="pill-dot" aria-hidden="true" /> Verification layer for autonomous operations
          </p>
          <h1 id="hero-title" className="hero-title">
            <span className="line">
              <span>AI that </span>
              <em className="grad-text">proves</em>
            </span>
            <span className="line">
              <span>the fix before it</span>
            </span>
            <span className="line">
              <span>touches production.</span>
            </span>
          </h1>
          <p className="hero-sub">
            TwinOps reproduces a network incident inside an isolated digital twin, lets AI test competing fixes there, attacks its own best answer — and hands a human only the change that survived the evidence.
          </p>
          <div className="hero-ctas">
            <Link to="/workbench?autostart=1" className="btn btn-break-sm">
              <Zap size={18} aria-hidden="true" /> Break the network
            </Link>
            <a href="#how" className="btn btn-ghost">
              See how it works <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
          <dl className="hero-stats">
            {stats.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <HeroScene />
      </div>
    </section>
  );
}

function Marquee() {
  const words = ['Observe', 'Diagnose', 'Reproduce', 'Experiment', 'Challenge', 'Prove', 'Approve', 'Apply'];
  const row = (hidden: boolean) => (
    <div className="marquee-row" aria-hidden={hidden}>
      {words.map((w) => (
        <span key={w}>
          {w} <i aria-hidden="true">✦</i>
        </span>
      ))}
    </div>
  );
  return (
    <div className="marquee" role="presentation">
      <div className="marquee-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

function Problem() {
  const cards = [
    { icon: Clock3, title: 'Investigation is slow', body: 'Engineers correlate alarms, topology, configs, recent changes and customer impact across many tools — by hand, under pressure.' },
    { icon: Flame, title: 'Fixes are tried on live infrastructure', body: 'The usual remedy is “hope it works”. A wrong change extends the outage — or quietly opens a new one.' },
    { icon: MessageSquareWarning, title: 'AI suggestions can’t be acted on', body: 'A chatbot answer is not evidence. Change boards need proof, and incident knowledge leaves with people.' },
  ];
  return (
    <section id="problem" className="section problem" aria-labelledby="problem-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">01 — The problem</p>
          <h2 id="problem-title">
            A plausible answer <span className="grad-text-warn">is not evidence.</span>
          </h2>
          <p className="lead">LLMs can already suggest fixes. The unsolved question is whether anyone can trust an AI to change critical infrastructure. TwinOps answers it differently: don’t trust the reasoning — make it prove the change.</p>
        </header>
        <div className="problem-grid">
          {cards.map((c, i) => (
            <article key={c.title} className="glass-card" data-reveal style={{ '--d': `${i * 90}ms` } as CSSProperties} onPointerMove={spotlight}>
              <span className="card-icon">
                <c.icon size={22} aria-hidden="true" />
              </span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </article>
          ))}
        </div>
        <blockquote className="big-quote" data-reveal>
          <p>“The AI isn’t impressive because it knew the answer. It’s impressive because it was allowed to be wrong safely — until it could prove one.”</p>
        </blockquote>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="final-glow" aria-hidden="true" />
      <div className="container final-inner" data-reveal>
        <h2 id="final-title">
          Let AI be wrong safely — <span className="grad-text">until it can prove it’s right.</span>
        </h2>
        <p>Press the button. A sealed fault breaks the demo network. Watch TwinOps reproduce it, reject the tempting fix and hand you the one that survived.</p>
        <Link to="/workbench?autostart=1" className="btn btn-break-sm btn-lg">
          <Zap size={20} aria-hidden="true" /> Break the network
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div>
          <Brand />
          <p>Synthetic networks and synthetic data only. No production access, no customer data. Evidence under tested scenarios — never a guarantee.</p>
        </div>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#gate">Proof Gate</a>
          <a href="#architecture">Architecture</a>
          <a href="#evaluation">Evaluation</a>
          <Link to="/workbench">Workbench</Link>
        </nav>
      </div>
    </footer>
  );
}

export function Landing({ theme, onToggleTheme }: Props) {
  useReveal([]);
  return (
    <div className="site">
      <SiteHeader variant="site" theme={theme} onToggleTheme={onToggleTheme} />
      <main id="main" tabIndex={-1}>
        <Hero />
        <Marquee />
        <Problem />
        <Story />
        <TemptingFix />
        <ProofGateSection />
        <GenAiSplit />
        <Architecture />
        <EvaluationLab />
        <Horizon />
        <Honest />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
