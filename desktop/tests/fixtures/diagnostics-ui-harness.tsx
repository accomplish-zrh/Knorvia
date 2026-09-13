'use client';
// C05 acceptance harness: mounts the REAL RuntimeDiagnosticsPanel against a
// minimal provider stand-in whose `request` opens the same one-time-token
// WebSocket a real browser tab uses, straight to the real loopback dev
// gateway (real daemon + real runtime-diagnostics handler behind it).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeDiagnosticsPanel } from '../../../web/components/native/RuntimeDiagnosticsPanel';
import { WorkbenchProvider, type WorkbenchShimValue } from './ssh-ui-provider-shim';

type Session = { protocol: string; url: string; token: string };

export function DiagnosticsHarness() {
  const [ready, setReady] = useState(false);
  const [marker, setMarker] = useState('BOOTSTRAP:pending');
  const socketRef = useRef<WebSocket | null>(null);
  const nextId = useRef(1);
  const pending = useRef(new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>());

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const sessionResponse = await fetch('/session');
      const session: Session = await sessionResponse.json();
      if (disposed) return;
      const wsUrl = session.url.startsWith('ws') ? session.url : `${session.url}`;
      const socket = new WebSocket(wsUrl, [session.protocol, `knorvia.native.token.${session.token}`]);
      socketRef.current = socket;
      socket.onopen = () => { setMarker('BOOTSTRAP:ready'); setReady(true); };
      socket.onerror = () => setMarker('BOOTSTRAP:error');
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id === undefined || message.id === null) return;
        const waiter = pending.current.get(Number(message.id));
        if (!waiter) return;
        pending.current.delete(Number(message.id));
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message || 'rpc failed'), { rpc: message.error }));
        else waiter.resolve(message.result);
      };
    })().catch(error => setMarker(`BOOTSTRAP:error:${error}`));
    return () => { disposed = true; socketRef.current?.close(); };
  }, []);

  const value = useMemo<WorkbenchShimValue>(() => ({
    request: async (method: string, params?: unknown) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('gateway websocket is not open');
      const id = nextId.current += 1;
      const result = new Promise((resolve, reject) => { pending.current.set(id, { resolve, reject }); });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return result;
    },
    t: (zh: string) => zh,
    workspaces: [],
  }), []);
  return (
    <main style={{ fontFamily: 'system-ui', margin: '24px', maxWidth: 760 }} data-testid="diagnostics-harness">
      <h1 style={{ fontSize: 18 }}>运行诊断验收（C05）</h1>
      <div data-testid="bootstrap-marker">{marker}</div>
      {ready && (
        <WorkbenchProvider value={value}>
          <RuntimeDiagnosticsPanel />
        </WorkbenchProvider>
      )}
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<DiagnosticsHarness />);
