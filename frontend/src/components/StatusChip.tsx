import { AlertTriangle, Check, Clock, Info, Minus, Sparkles, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type ChipTone = 'ok' | 'fail' | 'warn' | 'info' | 'pending' | 'ai' | 'twin' | 'prod' | 'skip';

const ICONS: Record<ChipTone, ReactNode> = {
  ok: <Check size={13} strokeWidth={3} />,
  fail: <X size={13} strokeWidth={3} />,
  warn: <AlertTriangle size={12} strokeWidth={2.6} />,
  info: <Info size={12} strokeWidth={2.6} />,
  pending: <Clock size={12} strokeWidth={2.6} />,
  ai: <Sparkles size={12} strokeWidth={2.4} />,
  twin: <Sparkles size={12} strokeWidth={2.4} />,
  prod: <Info size={12} strokeWidth={2.6} />,
  skip: <Minus size={12} strokeWidth={3} />,
};

/** Status is never conveyed by colour alone: every chip carries an icon and a word. */
export function StatusChip({ tone, children, className = '' }: { tone: ChipTone; children: ReactNode; className?: string }) {
  return (
    <span className={`chip chip-${tone} ${className}`}>
      {ICONS[tone]}
      <span>{children}</span>
    </span>
  );
}
