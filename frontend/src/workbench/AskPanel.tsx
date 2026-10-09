import { MessageSquareText, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { askIncident, type AskAnswer } from '../api/live.ts';
import { StatusChip } from '../components/StatusChip.tsx';

const SUGGESTIONS = ['Why was the first candidate rejected?', 'What evidence supports the top hypothesis?', 'What has not been tested?', 'Is the selected change safe for IPv6 users?'];

interface Exchange {
  id: number;
  question: string;
  answer?: AskAnswer;
  error?: string;
}

/** Operator Q&A grounded in this run's evidence. Answers are text only; cited IDs are verified server-side. */
export function AskPanel({ incidentId, model, ready }: { incidentId: string; model: string; ready: boolean }) {
  const [question, setQuestion] = useState('');
  const [items, setItems] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const remaining = items.find((i) => i.answer)?.answer?.remaining;
  const exhausted = remaining === 0;

  const ask = async (q: string) => {
    const text = q.trim();
    if (text.length < 3 || busy || exhausted) return;
    const id = Date.now();
    setBusy(true);
    setQuestion('');
    setItems((xs) => [{ id, question: text }, ...xs]);
    try {
      const answer = await askIncident(incidentId, text);
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (err) {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, error: err instanceof Error ? err.message : String(err) } : x)));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  return (
    <div className="ask">
      <form className="ask-form" onSubmit={submit}>
        <label htmlFor="ask-input">
          <MessageSquareText size={15} aria-hidden="true" /> Ask about this run <span className="muted">· answered by {model} from this run's evidence only</span>
        </label>
        <div className="ask-row">
          <input
            id="ask-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={400}
            autoComplete="off"
            placeholder={ready ? 'e.g. Why did the gate reject the rollback?' : 'Questions open at the verdict'}
            disabled={!ready || exhausted}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || busy || exhausted || question.trim().length < 3}>
            <Send size={14} aria-hidden="true" /> {busy ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        {ready && (
          <div className="ask-suggest" role="group" aria-label="Suggested questions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => void ask(s)} disabled={busy || exhausted}>
                {s}
              </button>
            ))}
          </div>
        )}
      </form>

      <ol className="ask-list" aria-live="polite">
        {items.map((x) => (
          <li key={x.id}>
            <p className="ask-q">{x.question}</p>
            {!x.answer && !x.error && <p className="ask-a muted">{model} is reading the evidence…</p>}
            {x.error && (
              <p className="ask-a">
                <StatusChip tone="fail">No answer</StatusChip> {x.error}
              </p>
            )}
            {x.answer && (
              <>
                <p className="ask-a">{x.answer.answer}</p>
                <p className="ask-meta">
                  {!x.answer.answerable && <StatusChip tone="warn">{x.answer.evidenceIds.length ? 'Partly outside the evidence' : 'Not in the evidence'}</StatusChip>}
                  {x.answer.evidenceIds.length ? (
                    <span className="ask-ids">
                      <StatusChip tone="ok">{x.answer.evidenceIds.length} cited IDs verified</StatusChip>
                      {x.answer.evidenceIds.map((e) => (
                        <code key={e}>{e}</code>
                      ))}
                    </span>
                  ) : (
                    <StatusChip tone="warn">cites no evidence; read the Proof Pack</StatusChip>
                  )}
                  {x.answer.discardedIds.length > 0 && <StatusChip tone="fail">{x.answer.discardedIds.length} invented IDs dropped</StatusChip>}
                  <span className="muted">
                    {x.answer.model} · {(x.answer.latencyMs / 1000).toFixed(1)} s · AI answer, not authoritative · {x.answer.remaining} questions left
                  </span>
                </p>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
