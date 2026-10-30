export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand${compact ? ' brand-compact' : ''}`}>
      <img
        className="brand-logo brand-logo-light"
        src="/twinops-logo.png"
        width={1132}
        height={372}
        alt="TwinOps - Digital Twin Operations"
      />
      <img
        className="brand-logo brand-logo-dark"
        src="/twinops-logo-dark.png"
        width={1132}
        height={372}
        alt="TwinOps - Digital Twin Operations"
      />
    </span>
  );
}
