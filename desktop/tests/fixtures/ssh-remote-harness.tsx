'use client';
// C13/C16 acceptance harness: mounts the REAL RemoteWorkspace (host form +
// connect dialog + SSH files panel) with the workbench provider shimmed so
// every RPC is proxied to the local bridge, which fronts the real desktop
// ssh-session module and real in-process ssh2 bastion/target servers.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteWorkspace } from '../../../web/components/native/RemoteWorkspace';
import { WorkbenchProvider, type WorkbenchShimValue } from './ssh-ui-provider-shim';

export function SshRemoteHarness() {
  const [theme] = useState('light');
  const value = useMemo<WorkbenchShimValue>(() => ({
    request: async (method: string, params?: unknown) => {
      const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const data = await response.json();
      if (data.rpcError) throw Object.assign(new Error(data.rpcError.message || 'rpc failed'), { rpc: data.rpcError });
      return data.result;
    },
    t: (zh: string) => zh,
    connection: 'connected',
    theme,
    workspaces: [{ id: 'fixture-project', title: 'Fixture project' }],
  }), [theme]);
  return (
    <main style={{ fontFamily: 'system-ui', margin: '24px', maxWidth: 640 }} data-testid="ssh-remote-harness">
      <div data-testid="harness-ready">READY</div>
      <WorkbenchProvider value={value}>
        <RemoteWorkspace threadId="fixture-thread" />
      </WorkbenchProvider>
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<SshRemoteHarness />);
