'use client';
// C03 acceptance harness: mounts the REAL SshFilesPanel against the shimmed
// workbench provider, proxying requests to the local bridge in front of the
// real desktop ssh-session module and a real local ssh2 server (1251 files).
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SshFilesPanel } from '../../../web/components/native/SshFilesPanel';
import { WorkbenchProvider, type WorkbenchShimValue } from './ssh-ui-provider-shim';

type Bootstrap = { sessionId: string; entryCount: number; openDirCount: number };

export function SshFilesHarness() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [marker, setMarker] = useState('');
  useEffect(() => {
    void fetch('/bootstrap').then(r => r.json()).then(value => {
      setBootstrap(value);
      setMarker(`BOOTSTRAP:${value.entryCount}`);
    });
  }, []);
  const value = useMemo<WorkbenchShimValue>(() => ({
    request: async (method: string, params?: unknown) => {
      const response = await fetch('/ssh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const data = await response.json();
      if (data.rpcError) throw Object.assign(new Error(data.rpcError.message || 'rpc failed'), { rpc: data.rpcError });
      return data.result;
    },
    t: (zh: string, en: string) => zh,
    workspaces: [],
  }), []);
  return (
    <main style={{ fontFamily: 'system-ui', margin: '24px', maxWidth: 560 }} data-testid="ssh-harness">
      <h1 style={{ fontSize: 18 }}>SSH 文件分页验收（C03）</h1>
      <div data-testid="bootstrap-marker">{marker}</div>
      {bootstrap && (
        <WorkbenchProvider value={value}>
          <SshFilesPanel sessionId={bootstrap.sessionId} threadId="fixture-thread" />
        </WorkbenchProvider>
      )}
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<SshFilesHarness />);
