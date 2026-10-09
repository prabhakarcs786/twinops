import { Landing } from './landing/Landing.tsx';
import { useTheme } from './lib/hooks.ts';
import { usePath } from './lib/router.tsx';
import { Workbench } from './workbench/Workbench.tsx';

export function App() {
  const path = usePath();
  const { theme, toggle } = useTheme();
  if (path.startsWith('/workbench')) return <Workbench key="wb" theme={theme} onToggleTheme={toggle} />;
  return <Landing theme={theme} onToggleTheme={toggle} />;
}
