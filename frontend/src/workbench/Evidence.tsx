import { Download, FileCode2, FileText } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';
import { describeStep } from '../engine/catalogue.ts';
import { VERDICT_LABEL } from '../engine/orchestrator.ts';
import { shortHash } from '../engine/sha256.ts';
import type { Frame, GateCheck, GateStatus } from '../engine/types.ts';
import type { RunView } from './runView.ts';

const GATE_NAMES: Record<string, string> = {
  G1: 'Reproduced in twin',
  G2: 'Restores affected journeys',
  G3: 'No regression · negative tests',
  G4: 'Survives challenges',
  G5: 'Policy & blast radius',
  G6: 'Rollback rehearsed',
  G7: 'Soft checks',
  G8: 'Human approval',
};

const GATE_TONE: Record<GateStatus, ChipTone> = { pass: 'ok', fail: 'fail', warn: 'warn', skip: 'skip', pending: 'pending' };

type Tab = 'hypotheses' | 'gate' | 'diff' | 'pack';
const TABS: { id: Tab; label: string }[] = [
  { id: 'hypotheses', label: 'Hypotheses' },
  { id: 'gate', label: 'Proof Gate' },
  { id: 'diff', label: 'Diff & rollback' },
  { id: 'pack', label: 'Proof Pack' },
];

interface Props {
  view: RunView | null;
  frame: Frame;
  inspectId: string | null;
  onInspect: (id: string) => void;
  verdictVisible: boolean;
  decisionVisible: boolean;
}

export function Evidence({ view, frame, inspectId, onInspect, verdictVisible, decisionVisible }: Props) {
  const [tab, setTab] = useState<Tab>('hypotheses');
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ hypotheses: null, gate: null, diff: null, pack: null });

  const decided = frame.candidates.filter((c) => ['pass', 'warn', 'rejected', 'superseded'].includes(c.status));
  const activeId = inspectId && decided.some((c) => c.id === inspectId) ? inspectId : (frame.selectedId ?? decided.at(-1)?.id ?? null);
  const record = view?.run.candidates.find((c) => c.change.id === activeId);
  const approval = decisionVisible && record && record.change.id === view?.run.selected?.change.id ? view?.approval : undefined;
  const gates = record?.gates.map((g): GateCheck => {
    if (g.id !== 'G8' || !approval || !view?.outcome) return g;
    if (approval.decision === 'reject') return { ...g, status: 'fail', reason: `rejected by ${approval.operator}` };
    if (view.outcome.status === 'refused') return { ...g, status: 'fail', reason: view.outcome.reason };
    return { ...g, status: 'pass', reason: `approved by ${approval.operator} · token ${shortHash(approval.token)}` };
  });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };

  const picker = decided.length > 0 && (
    <div className="picker" role="group" aria-label="Choose a candidate">
      {decided.map((c) => (
        <button key={c.id} type="button" className={c.id === activeId ? 'is-on' : ''} aria-pressed={c.id === activeId} onClick={() => onInspect(c.id)}>
          {c.label.split(' · ')[0]}
        </button>
      ))}
    </div>
  );

  return (
    <section className="evidence" aria-label="Evidence">
      <div className="tabs" role="tablist" aria-label="Evidence views" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            type="button"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel" tabIndex={0}>
        {tab === 'hypotheses' &&
          (frame.hypotheses.length ? (
            <ol className="hyps">
              {frame.hypotheses.map((h) => (
                <li key={h.id} className={h.rank === 1 ? 'is-top' : ''}>
                  <span className="hyp-rank">H{h.rank}</span>
                  <div>
                    <p className="hyp-title">{h.title}</p>
                    <p className="hyp-why">{h.rationale}</p>
                    <p className="hyp-evidence">
                      <span>
                        <StatusChip tone="ok">{h.supporting.length} supporting</StatusChip> {h.supporting.join(' · ')}
                      </span>
                      <span>
                        <StatusChip tone={h.contradicting.length ? 'fail' : 'skip'}>{h.contradicting.length} contradicting</StatusChip> {h.contradicting.join(' · ')}
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Hypotheses are ranked from observations only — probes, alarms, change history. No confidence percentages: evidence counts instead.</p>
          ))}

        {tab === 'gate' &&
          (record ? (
            <>
              {picker}
              <p className="gate-head">
                <strong>{record.change.label}</strong> <code>{shortHash(record.change.hash)}</code>
              </p>
              <ul className="gates">
                {gates!.map((g) => (
                  <li key={g.id}>
                    <span className="gate-id">{g.id}</span>
                    <span className="gate-name">{GATE_NAMES[g.id]}</span>
                    <StatusChip tone={GATE_TONE[g.status]}>{g.status}</StatusChip>
                    <span className="gate-reason">{g.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">The Proof Gate is deterministic code. Each candidate gets a verdict with reasons; the model cannot edit tests or approve itself.</p>
          ))}

        {tab === 'diff' &&
          (record ? (
            <>
              {picker}
              <p className="gate-head">
                <strong>{record.change.steps.map(describeStep).join(' + ')}</strong>
              </p>
              {record.diff.length ? (
                <div className="table-wrap" role="region" aria-label="Configuration diff" tabIndex={0}>
                  <table className="diff">
                    <caption className="sr-only">Configuration diff for {record.change.label}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Node</th>
                        <th scope="col">Path</th>
                        <th scope="col">Before</th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {record.diff.map((d) => (
                        <tr key={d.path}>
                          <td>{d.node}</td>
                          <td>
                            <code>{d.path}</code>
                          </td>
                          <td className="del">{d.before}</td>
                          <td className="add">{d.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">No persistent configuration change (process restart only).</p>
              )}
              <p className="rollback">
                <StatusChip tone={record.rollback.matches ? 'ok' : 'fail'}>Rollback {record.rollback.matches ? 'rehearsed' : 'failed'}</StatusChip>
                restores captured state hash <code>{shortHash(record.rollback.restoredHash)}</code>
              </p>
              {record.challenges.length > 0 && (
                <ul className="challenges">
                  {record.challenges.map((c) => (
                    <li key={c.id}>
                      <StatusChip tone={c.ok ? 'ok' : c.soft ? 'warn' : 'fail'}>{c.label}</StatusChip>
                      <span>{c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">Every candidate is a typed change from the catalogue — never a free-text command — so its exact diff can be reviewed.</p>
          ))}

        {tab === 'pack' &&
          (view && verdictVisible ? (
            <div className="pack">
              <p>
                <strong>{VERDICT_LABEL[view.run.verdict]}</strong> · {view.run.runId} · {view.run.mode}
              </p>
              <p className="muted">Verified under tested scenarios only. Twin evidence is not a guarantee of production safety.</p>
              <h3>Untested conditions</h3>
              <ul className="untested">
                {view.run.untested.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
              <div className="pack-actions">
                <button type="button" className="btn btn-ghost" onClick={view.downloadJson}>
                  <FileCode2 size={16} aria-hidden="true" /> Download JSON
                </button>
                <button type="button" className="btn btn-ghost" onClick={view.downloadHtml}>
                  <FileText size={16} aria-hidden="true" /> Download HTML report
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">
              <Download size={14} aria-hidden="true" /> The Proof Pack — observations, hypotheses, every experiment, rejected options, rollback, approval and untested conditions — becomes available at the verdict.
            </p>
          ))}
      </div>
    </section>
  );
}
