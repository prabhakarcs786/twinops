import { Deck } from './deck/Deck.tsx';
import { Landing } from './landing/Landing.tsx';
import { useTheme } from './lib/hooks.ts';
import { usePath } from './lib/router.tsx';
import { Workbench } from './workbench/Workbench.tsx';
import { ReviewTrial } from './workbench/ReviewTrial.tsx';
import { Connections } from './workbench/Connections.tsx';
import { AccessGate } from './components/AccessGate.tsx';

export function App() {
  const path = usePath();
  const { theme, toggle } = useTheme();
  if (path.startsWith('/connections')) return <AccessGate><Connections theme={theme} onToggleTheme={toggle} /></AccessGate>;
  if (path.startsWith('/review')) return <AccessGate><ReviewTrial theme={theme} onToggleTheme={toggle} /></AccessGate>;
  if (path.startsWith('/workbench')) return <AccessGate><Workbench key="wb" theme={theme} onToggleTheme={toggle} /></AccessGate>;
  if (path.startsWith('/deck')) return <Deck />;
  return <Landing theme={theme} onToggleTheme={toggle} />;
}
