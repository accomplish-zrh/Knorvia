'use client';
import { useCallback, useEffect, useState } from 'react';
import { Network, Plus, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './ssh.css';

type Forward = { forwardId: string; remoteHost: string; remotePort: number; localPort: number; status: 'active' | 'closed' | 'failed' | 'detached'; connectionsServed: number; connectionsActive: number; error: string };

// RF-D01: manage local forwards on one trusted SSH session. Listeners always
// bind 127.0.0.1; the remote host:port is fixed at creation.
export function SshForwardsPanel({ sessionId }: { sessionId: string }) {
  const { request, t } = useWorkbench();
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [remoteHost, setRemoteHost] = useState('localhost'), [remotePort, setRemotePort] = useState('3000'), [localPort, setLocalPort] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setForwards((await request<{ forwards: Forward[] }>('ssh/forward/list', { sessionId })).forwards); }
    catch { /* the session is ending; its forwards are gone with it */ }
  }, [request, sessionId]);
  useEffect(() => { void load(); }, [load]);
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const statusLabel = (x: Forward) => x.status === 'active' ? t('转发中', 'Active') : x.status === 'closed' ? t('已关闭', 'Closed') : x.status === 'detached' ? t('连接中断，已释放', 'Disconnected, released') : t('失败', 'Failed');
  return <section className="nw-ssh-forwards" aria-label={t('本地端口转发', 'Local port forwards')}>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    <div className="nw-ssh-forward-form">
      <label className="nw-field">{t('远端主机', 'Remote host')}<input value={remoteHost} onChange={e => setRemoteHost(e.target.value)} /></label>
      <label className="nw-field">{t('远端端口', 'Remote port')}<input type="number" min={1} max={65535} value={remotePort} onChange={e => setRemotePort(e.target.value)} /></label>
      <label className="nw-field">{t('本地端口（留空自动）', 'Local port (blank = auto)')}<input type="number" min={0} max={65535} placeholder={t('自动', 'Auto')} value={localPort} onChange={e => setLocalPort(e.target.value)} /></label>
      <button className="nw-button" disabled={busy || !remoteHost || !remotePort} onClick={() => void action(async () => {
        await request('ssh/forward/start', { sessionId, remoteHost, remotePort: Number(remotePort), ...(localPort ? { localPort: Number(localPort) } : {}) });
        setLocalPort('');
      })}><Plus size={14} />{t('添加转发', 'Add forward')}</button>
    </div>
    <p className="nw-help">{t('只监听 127.0.0.1；例如把远端 localhost:3000 的预览暴露到本机浏览器。断开会释放全部转发。', 'Listens on 127.0.0.1 only — e.g. expose a remote localhost:3000 preview to your browser. Disconnecting releases all forwards.')}</p>
    {forwards.length > 0 && <ul className="nw-ssh-forward-list">{forwards.map(x => <li key={x.forwardId}>
      <Network size={14} />
      <span>127.0.0.1:{x.localPort} → {x.remoteHost}:{x.remotePort}</span>
      <small>{statusLabel(x)}{x.status === 'active' ? ` · ${x.connectionsActive} ${t('活动', 'active')}` : ''}{x.error ? ` · ${x.error}` : ''}</small>
      {(x.status === 'active') && <button className="nw-icon" aria-label={t('关闭转发', 'Close forward')} disabled={busy} onClick={() => void action(() => request('ssh/forward/close', { sessionId, forwardId: x.forwardId }))}><X size={13} /></button>}
    </li>)}</ul>}
  </section>;
}
