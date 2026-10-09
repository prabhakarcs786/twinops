import { Bot, Clock3, Cpu, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StatusChip, type ChipTone } from '../components/StatusChip.tsx';
import type { Frame, RunEvent } from '../engine/types.ts';

interface CallRaw {
  role?: string;
  latencyMs?: number | null;
  tokens?: number;
  rejected?: string[];
  fallback?: boolean;
  error?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  diagnose: 'Diagnose',
  propose: 'Propose fixes',
  challenge: 'Pick challenges',
  revise: 'Revise',
  narrate: 'Brief approver',
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Live "model is reasoning" line; the timer restarts per call (keyed by event seq). */
export function ModelThinking({ event }: { event: RunEvent }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed(performance.now() - start), 250);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="thinking">
      <span className="thinking-dot" aria-hidden="true" />
      <span>
        <strong>{event.title}</strong> — {event.summary}
      </span>
      <span className="thinking-time" aria-hidden="true">
        {seconds(elapsed)}
      </span>
    </p>
  );
}

function callStatus(raw: CallRaw): { tone: ChipTone; text: string } {
  if (raw.error) return { tone: 'fail', text: 'error · runbook used' };
  if (raw.fallback) return { tone: 'warn', text: 'fallback to runbook' };
  if (raw.rejected?.length) return { tone: 'warn', text: `${raw.rejected.length} discarded` };
  return { tone: 'ok', text: 'accepted' };
}

export function AiTrace({ events, frame }: { events: RunEvent[]; frame: Frame }) {
  const calls = events.filter((e) => e.kind === 'planner_note').map((e) => ({ e, raw: (e.raw ?? {}) as CallRaw }));
  const last = events.at(-1);
  const pending = last?.kind === 'model_call' ? last : undefined;

  if (!calls.length && !pending) {
    return (
      <p className="muted">
        This run used the deterministic runbook planner, so no model calls were made. Configure Gemini, Ollama or an OpenAI-compatible endpoint in <code>.env</code> and run on the live backend to
        see every model call here, with its latency, tokens and what the Proof Gate did with its output.
      </p>
    );
  }

  const totalMs = calls.reduce((s, c) => s + (c.raw.latencyMs ?? 0), 0);
  const tokens = calls.reduce((s, c) => s + (c.raw.tokens ?? 0), 0);
  const discarded = calls.reduce((s, c) => s + (c.raw.rejected?.length ?? 0), 0);
  const fallbacks = calls.filter((c) => c.raw.fallback).length;
  const revisions = calls.filter((c) => c.raw.role === 'revise' && !c.raw.fallback && / revised /.test(c.e.title)).length;
  // With an LLM planner, revisions are model-authored unless the revise call fell back to the runbook.
  const modelFixes = frame.candidates.filter((c) => c.origin === 'llm' || (c.origin === 'revision' && revisions > 0));
  const proposed = modelFixes.length - revisions;
  const passed = modelFixes.filter((c) => c.status === 'pass' || c.status === 'warn').length;
  const stopped = modelFixes.filter((c) => c.status === 'rejected' || c.status === 'superseded').length;
  const testing = modelFixes.length - passed - stopped;
  const maxMs = Math.max(1, ...calls.map((c) => c.raw.latencyMs ?? 0));

  return (
    <div className="ai-trace">
      <p className="ai-headline">
        <Bot size={16} aria-hidden="true" />
        <span>
          The model proposed {plural(proposed, 'fix', 'fixes')}
          {revisions ? ` and ${plural(revisions, 'revision')}` : ''}. The deterministic Proof Gate passed <strong>{passed}</strong> and stopped <strong>{stopped}</strong>
          {testing > 0 ? ` (${testing} still in test)` : ''}. Nothing the model wrote reached the network without passing the gate.
        </span>
      </p>

      <dl className="ai-tiles">
        <div>
          <dt>
            <Cpu size={14} aria-hidden="true" /> Model calls
          </dt>
          <dd>
            {calls.length}
            {pending ? ' + 1 running' : ''} <small>{seconds(totalMs)} total</small>
          </dd>
        </div>
        <div>
          <dt>
            <Clock3 size={14} aria-hidden="true" /> Tokens
          </dt>
          <dd>{tokens.toLocaleString('en')}</dd>
        </div>
        <div>
          <dt>
            <ShieldCheck size={14} aria-hidden="true" /> Model fixes passed
          </dt>
          <dd>
            {passed} <small>of {modelFixes.length}</small>
          </dd>
        </div>
        <div className={stopped ? 'is-alert' : ''}>
          <dt>
            <ShieldX size={14} aria-hidden="true" /> Stopped by the gate
          </dt>
          <dd>{stopped}</dd>
        </div>
        <div className={discarded || fallbacks ? 'is-warn' : ''}>
          <dt>
            <TriangleAlert size={14} aria-hidden="true" /> Discarded · fallbacks
          </dt>
          <dd>
            {discarded} · {fallbacks}
          </dd>
        </div>
      </dl>

      <ol className="ai-calls" aria-label="Model calls in order">
        {calls.map(({ e, raw }) => {
          const status = callStatus(raw);
          return (
            <li key={e.seq}>
              <span className="ai-role">{ROLE_LABEL[raw.role ?? ''] ?? raw.role}</span>
              <div className="ai-call-body">
                <p className="ai-call-title">{e.title}</p>
                <p className="ai-call-summary">{e.summary}</p>
                {raw.rejected && raw.rejected.length > 0 && (
                  <details>
                    <summary>What validation discarded</summary>
                    <ul>
                      {raw.rejected.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div className="ai-call-meta">
                <StatusChip tone={status.tone}>{status.text}</StatusChip>
                <span className="ai-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, ((raw.latencyMs ?? 0) / maxMs) * 100)}%` }} />
                </span>
                <span className="ai-num">
                  {seconds(raw.latencyMs ?? 0)} · {(raw.tokens ?? 0).toLocaleString('en')} tok
                </span>
              </div>
            </li>
          );
        })}
        {pending && (
          <li key={pending.seq} className="is-pending">
            <span className="ai-role">In flight</span>
            <div className="ai-call-body">
              <ModelThinking key={pending.seq} event={pending} />
            </div>
          </li>
        )}
      </ol>
      <p className="muted ai-foot">The model proposes; deterministic code decides. Outputs are schema-validated, cited evidence IDs are checked against this run, and any failure falls back to the runbook visibly.</p>
    </div>
  );
}
