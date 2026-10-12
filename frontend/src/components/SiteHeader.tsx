import { ArrowRight, Menu, Moon, Sun, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from '../lib/router.tsx';
import { Brand } from './Brand.tsx';

const NAV = [
  { href: '#problem', label: 'Problem' },
  { href: '#how', label: 'How it works' },
  { href: '#gate', label: 'Proof Gate' },
  { href: '#architecture', label: 'Architecture' },
  { href: '#evaluation', label: 'Evaluation' },
];

interface Props {
  variant: 'site' | 'app';
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function SiteHeader({ variant, theme, onToggleTheme }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <header className={`site-header is-${variant}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner">
        <Link to="/" className="brand-link" aria-label="TwinOps home">
          <Brand compact={variant === 'app'} />
        </Link>

        {variant === 'site' && (
          <nav id="site-nav" className={`site-nav ${open ? 'is-open' : ''}`} aria-label="Primary">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
                {item.label}
              </a>
            ))}
            <Link to="/deck" onClick={() => setOpen(false)}>
              Deck
            </Link>
          </nav>
        )}
        {variant === 'app' && <span className="app-crumb">Workbench</span>}

        <div className="site-actions">
          <Link to="/connections" className="btn btn-ghost btn-sm">Applications</Link>
          <button type="button" className="icon-btn" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          {variant === 'site' ? (
            <Link to="/workbench" className="btn btn-primary btn-sm">
              Open workbench <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ) : (
            <Link to="/" className="btn btn-ghost btn-sm">
              Overview
            </Link>
          )}
          {variant === 'site' && (
            <button type="button" className="icon-btn nav-toggle" aria-expanded={open} aria-controls="site-nav" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((o) => !o)}>
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
