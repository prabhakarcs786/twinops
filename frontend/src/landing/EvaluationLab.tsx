import { FlaskConical, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { StatusChip } from '../components/StatusChip.tsx';
import { EVAL_FAULTS, evaluateOne, runControls, type ControlResult, type RunScore } from '../engine/evaluation.ts';
import { FAULT_INFO } from '../engine/harness.ts';
import type { FaultId } from '../engine/types.ts';

const SEEDS = 10;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function EvaluationLab() {
  const [scores, setScores] = useState<RunScore[]>([]);
  const [controls, setControls] = useState<ControlResult[]>([]);
  const [running, setRunning] = useState(false);
  const total = EVAL_FAULTS.length * SEEDS;

  const run = async () => {
    setRunning(true);
    setScores([]);
    setControls([]);
    const out: RunScore[] = [];
    for (const fault of EVAL_FAULTS) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        out.push(evaluateOne(fault, seed));
        setScores([...out]);
        await new Promise((r) => setTimeout(r, 24));
      }
    }
    setControls(runControls());
    setRunning(false);
  };

  const supported = scores.filter((s) => s.fault !== 'unsupported_link_flap');
  const unsupported = scores.filter((s) => s.fault === 'unsupported_link_flap');
  const done = scores.length === total && !running;
  const tiles = [
    { label: 'Root cause in top 3', value: `${supported.filter((s) => s.top3).length}/${supported.length}` },
    { label: 'Expected verdict', value: `${supported.filter((s) => s.verdictOk).length}/${supported.length}` },
    { label: 'Unsafe fixes that passed', value: String(scores.reduce((n, s) => n + s.unsafePassed, 0)), good: true },
    { label: 'Writes during diagnosis', value: String(scores.reduce((n, s) => n + s.prodWrites, 0)), good: true },
    { label: 'Unsupported fault stopped', value: `${unsupported.filter((s) => s.verdictOk).length}/${unsupported.length}` },
    { label: 'Adverse controls', value: `${controls.filter((c) => c.ok).length}/${controls.length || 6}` },
  ];

  const row = (fault: FaultId) => {
    const xs = scores.filter((s) => s.fault === fault);
    const has = xs.length > 0;
    return (
      <tr key={fault}>
        <th scope="row">
          <span className="fault-code">{FAULT_INFO[fault].code}</span> {FAULT_INFO[fault].label}
        </th>
        <td>{has ? `${xs.length}/${SEEDS}` : '—'}</td>
        <td>{has ? `${xs.filter((s) => s.top1).length}/${xs.length}` : '—'}</td>
        <td>{has ? `${xs.filter((s) => s.top3).length}/${xs.length}` : '—'}</td>
        <td>{has ? `${xs.filter((s) => s.verdictOk).length}/${xs.length}` : '—'}</td>
        <td>{has ? (xs.reduce((n, s) => n + s.experiments, 0) / xs.length).toFixed(1) : '—'}</td>
        <td>{has ? xs.reduce((n, s) => n + s.unsafeRejected, 0) : '—'}</td>
        <td>{has ? xs.reduce((n, s) => n + s.unsafePassed, 0) : '—'}</td>
        <td>{has ? `${median(xs.map((s) => s.computeMs)).toFixed(1)} ms` : '—'}</td>
      </tr>
    );
  };

  return (
    <section id="evaluation" className="section eval" aria-labelledby="eval-title">
      <div className="container">
        <header className="section-head" data-reveal>
          <p className="eyebrow">07 — Evaluation harness</p>
          <h2 id="eval-title">
            Don’t trust our claims. <span className="grad-text">Run the harness.</span>
          </h2>
          <p className="lead">
            {EVAL_FAULTS.length} fault families × {SEEDS} seeds, scored against a sealed answer key the planner never sees — plus six adverse controls: drift, tampered approval, operator rejection, out-of-catalogue action, unsupported fault and injected log instructions.
          </p>
        </header>

        <div className="eval-card" data-reveal>
          <div className="eval-top">
            <button type="button" className="btn btn-primary" onClick={run} disabled={running}>
              {running ? <FlaskConical size={16} aria-hidden="true" /> : done ? <RotateCcw size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              {running ? `Running ${scores.length}/${total}…` : done ? 'Run again' : `Run ${total} seeded incidents`}
            </button>
            <div className="eval-progress" role="progressbar" aria-label="Evaluation progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={scores.length}>
              <span style={{ width: `${(scores.length / total) * 100}%` }} />
            </div>
          </div>

          <dl className="eval-tiles">
            {tiles.map((t) => (
              <div key={t.label} className={t.good ? 'is-good' : ''}>
                <dt>{t.label}</dt>
                <dd>{scores.length ? t.value : '—'}</dd>
              </div>
            ))}
          </dl>

          <div className="table-wrap" role="region" aria-label="Evaluation results table" tabIndex={0}>
            <table className="eval-table">
              <caption className="sr-only">Evaluation results per fault family</caption>
              <thead>
                <tr>
                  <th scope="col">Fault family</th>
                  <th scope="col">Runs</th>
                  <th scope="col">H1 correct</th>
                  <th scope="col">Top 3</th>
                  <th scope="col">Expected verdict</th>
                  <th scope="col">Avg experiments</th>
                  <th scope="col">Unsafe rejected</th>
                  <th scope="col">Unsafe passed</th>
                  <th scope="col">Median compute</th>
                </tr>
              </thead>
              <tbody>{EVAL_FAULTS.map(row)}</tbody>
            </table>
          </div>

          {controls.length > 0 && (
            <ul className="eval-controls" aria-label="Adverse controls">
              {controls.map((c) => (
                <li key={c.id}>
                  <StatusChip tone={c.ok ? 'ok' : 'fail'}>{c.id}</StatusChip>
                  <strong>{c.name}</strong>
                  <span>
                    expected {c.expected} · observed {c.observed}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="eval-note">
            These numbers score the deterministic runbook planner on synthetic seeds of one topology. They are delivery evidence for this prototype — not production reliability estimates, and not a claim that an LLM would do better. That comparison is the next measurement.
          </p>
        </div>
      </div>
    </section>
  );
}
