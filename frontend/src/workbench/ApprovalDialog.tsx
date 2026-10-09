import { ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { StatusChip } from '../components/StatusChip.tsx';
import { describeStep } from '../engine/catalogue.ts';
import { VERDICT_LABEL } from '../engine/orchestrator.ts';
import { shortHash } from '../engine/sha256.ts';
import type { RunView } from './runView.ts';

interface Props {
  open: boolean;
  view: RunView;
  /** Backend requires an operator passcode (server-side token check). */
  requirePasscode?: boolean;
  busy?: boolean;
  error?: string | null;
  targetLabel?: string;
  onClose: () => void;
  onDecide: (operator: string, comment: string, decision: 'approve' | 'reject', passcode: string) => void;
}

export function ApprovalDialog({ open, view, requirePasscode = false, busy = false, error = null, targetLabel = 'demo network only', onClose, onDecide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [operator, setOperator] = useState('');
  const [comment, setComment] = useState('');
  const [passcode, setPasscode] = useState('');
  const [ack, setAck] = useState(false);
  const selected = view.run.selected!;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const missing = !operator.trim() || (requirePasscode && !passcode) || busy;
  const submit = (decision: 'approve' | 'reject') => (e?: FormEvent) => {
    e?.preventDefault();
    if (missing || (decision === 'approve' && !ack)) return;
    onDecide(operator.trim(), comment.trim(), decision, passcode);
  };

  return (
    <dialog ref={ref} className="approval" aria-labelledby="approval-title" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={submit('approve')}>
        <header>
          <div>
            <p className="stage-kicker">Human gate · G8</p>
            <h2 id="approval-title">Approve the exact tested change</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close approval dialog">
            <X size={18} />
          </button>
        </header>

        <div className="approval-grid">
          <div>
            <p className="approval-verdict">
              <StatusChip tone={view.run.verdict === 'PASS_UNDER_DEFINED_TESTS' ? 'ok' : 'warn'}>{VERDICT_LABEL[view.run.verdict]}</StatusChip>
            </p>
            <p className="approval-change">{selected.change.label}</p>
            <ul className="approval-steps">
              {selected.change.steps.map((s) => (
                <li key={describeStep(s)}>
                  <code>{describeStep(s)}</code>
                </li>
              ))}
            </ul>
            <dl className="approval-hashes">
              <div>
                <dt>Change hash</dt>
                <dd>
                  <code>{shortHash(selected.change.hash)}</code>
                </dd>
              </div>
              <div>
                <dt>Target state</dt>
                <dd>
                  <code>{shortHash(view.run.snapshotHash)}</code>
                </dd>
              </div>
              <div>
                <dt>Rollback</dt>
                <dd>{selected.rollback.matches ? 'rehearsed in twin' : 'not rehearsed'}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{targetLabel}</dd>
              </div>
            </dl>
            {selected.gates.some((g) => g.status === 'warn') && (
              <p className="approval-warn">
                <StatusChip tone="warn">G7 warning</StatusChip> {selected.gates.find((g) => g.id === 'G7')?.reason}
              </p>
            )}
          </div>
          <div>
            <h3>Not tested — read before approving</h3>
            <ul className="untested">
              {view.run.untested.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="approval-form">
          <label>
            <span>Operator ID</span>
            <input value={operator} onChange={(e) => setOperator(e.target.value)} required autoComplete="off" placeholder="e.g. noc-oncall-07" />
          </label>
          <label>
            <span>Comment (optional)</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} autoComplete="off" placeholder="Reviewed diff, rollback and untested conditions" />
          </label>
          {requirePasscode && (
            <label>
              <span>Operator passcode</span>
              <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} required autoComplete="off" />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I reviewed the evidence and the untested conditions. Approval binds to this hash and target state only.</span>
          </label>
          {error && (
            <p className="approval-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer>
          <button type="button" className="btn btn-ghost" onClick={submit('reject')} disabled={missing}>
            Reject change
          </button>
          <button type="submit" className="btn btn-primary" disabled={missing || !ack}>
            <ShieldCheck size={16} aria-hidden="true" /> {busy ? 'Applying…' : 'Approve & apply to demo lab'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
