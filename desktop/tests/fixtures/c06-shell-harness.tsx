import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchShell } from '../../../web/components/native/WorkbenchShell';
import { FixtureProvider, fixture } from './c06-shell-provider';

declare global { interface Window { c06: typeof fixture & { mount: () => void; unmount: () => void }; c06BridgeReady?: boolean; } }

function Harness() {
  const [mounted, setMounted] = useState(true);
  window.c06 = { ...fixture, mount: () => setMounted(true), unmount: () => setMounted(false) };
  return <FixtureProvider>{mounted ? <WorkbenchShell><p data-testid="c06-shell-mounted">Actual WorkbenchShell</p></WorkbenchShell> : <p data-testid="c06-shell-unmounted">Shell unmounted</p>}</FixtureProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
