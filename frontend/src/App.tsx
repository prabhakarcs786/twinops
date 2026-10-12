import { Deck } from './deck/Deck.tsx';
import { Landing } from './landing/Landing.tsx';
import { useTheme } from './lib/hooks.ts';
import { usePath } from './lib/router.tsx';
import { Workbench } from './workbench/Workbench.tsx';
import { ReviewTrial } from './workbench/ReviewTrial.tsx';
import { Connections } from './workbench/Connections.tsx';

export function App() {
  const path = usePath();
  const { theme, toggle } = useTheme();
  if (path.startsWith('/connections')) return <Connections theme={theme} onToggleTheme={toggle} />;
  if (path.startsWith('/review')) return <ReviewTrial theme={theme} onToggleTheme={toggle} />;
  if (path.startsWith('/workbench')) return <Workbench key="wb" theme={theme} onToggleTheme={toggle} />;
  if (path.startsWith('/deck')) return <Deck />;
  return <Landing theme={theme} onToggleTheme={toggle} />;
}
