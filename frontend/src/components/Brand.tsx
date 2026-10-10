/** Paired T forms: the live system and its independently verified twin. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path className="brand-mark-primary" d="M4 8h23l-8 8h-2v24H9V16H4Z" />
      <path className="brand-mark-secondary" d="M32 8h12v8H33v24h-8V16Z" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand${compact ? ' brand-compact' : ''}`}>
      <BrandMark />
      <span className="brand-lockup">
        <span className="brand-word">Twin<span>Ops</span></span>
        {!compact && <span className="brand-tag">Verified operations</span>}
      </span>
    </span>
  );
}
