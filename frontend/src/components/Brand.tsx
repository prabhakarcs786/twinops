import { useId } from 'react';

export function BrandMark({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`tg-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b6cff" />
          <stop offset="1" stopColor="#38c7ff" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill={`url(#tg-${id})`} opacity="0.16" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="none" stroke={`url(#tg-${id})`} strokeOpacity="0.5" />
      <circle cx="12" cy="18.5" r="5" fill={`url(#tg-${id})`} />
      <circle cx="20.5" cy="11.5" r="5" fill="none" stroke={`url(#tg-${id})`} strokeWidth="2" strokeDasharray="2.6 2.1" />
      <path d="M15.5 15.6 17.2 14.3" stroke={`url(#tg-${id})`} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <BrandMark />
      <span className="brand-word">
        Twin<span>Ops</span>
      </span>
      {!compact && <span className="brand-tag">verification layer</span>}
    </span>
  );
}
