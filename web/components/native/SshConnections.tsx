'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Plus, Server, ShieldCheck, TerminalSquare, Trash2, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import type { SshChallenge, SshHost, SshSession } from '@/lib/native-ssh';
import './ssh.css';
const blank = { name: '', hostname: '', port: 22, username: '', root: '', auth: 'agent' as SshHost['auth'], keyPath: '' };
export function SshConnections({ onOpenSession }: { onOpenSession?: (session: SshSession) => void }) {
  const { request, t, connection } = useWorkbench();
  const [hosts, setHosts] = useState<SshHost[]>([]), [sessions, setSessions] = useState<SshSession[]>([]), [challenges, setChallenges] = useState<SshChallenge[]>([]);
  const [draft, setDraft] = useState<Partial<SshHost>>(blank), [editing, setEditing] = useState(false), [secret, setSecret] = useState('');
  const [connectHost, setConnectHost] = useState<SshHost>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SshHost>();
  const pending = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const [catalog, active] = await Promise.all([request<{ hosts: SshHost[]; pendingTrust: SshChallenge[] }>('ssh/host/list', {}), request<SshSession[]>('ssh/list', {})]);
    setHosts(catalog.hosts); setChallenges(catalog.pendingTrust); setSessions(active);
  }, [request]);
  useEffect(() => { if (connection === 'connected') { setError(''); void load().catch(e => setError(errorText(e))); } }, [load, connection]);
  const action = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (e) { setError(errorText(e)); await load().catch(() => {}); } finally { setBusy(false); } };
  const connect = (host: SshHost) => action(async () => {
    const id = crypto.randomUUID(); pending.current = id;
    try { const result = await request<SshSession>('ssh/open', { sessionId: id, hostId: host.id, cols: 100, rows: 30, ...(secret ? { secret } : {}) }); setConnectHost(undefined); setSecret(''); onOpenSession?.(result); }
    finally { pending.current = undefined; }
  });
  const cancelConnect = () => { if (pending.current) void request('ssh/close', { sessionId: pending.current }).catch(() => {}); setConnectHost(undefined); setSecret(''); };
  return <section className="nw-ssh-settings">
    <div className="nw-page-heading"><div><h2><Server size={20} /> {t('SSH 连接', 'SSH connections')}</h2><p>{t('保存主机，在右侧终端连接远程工作目录。', 'Save a host and connect to its remote folder in the side terminal.')}</p></div><button className="nw-button" onClick={() => { setDraft(blank); setEditing(true); }}><Plus size={15} />{t('添加主机', 'Add host')}</button></div>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {!hosts.length && <p className="nw-help">{t('添加服务器地址与登录方式即可开始。首次连接会展示服务器指纹。', 'Add a server and authentication method. The first connection shows its fingerprint.')}</p>}
    <div className="nw-ssh-hosts">{hosts.map(host => <div className="nw-ssh-host" key={host.id}><Server size={19} /><div><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small><small>{host.root || t('远程主目录', 'Remote home')}</small></div><button className="nw-button" disabled={busy} onClick={() => { setConnectHost(host); setSecret(''); }}>{t('连接', 'Connect')}</button><button className="nw-button" disabled={busy} onClick={() => { setDraft(host); setEditing(true); }}>{t('编辑', 'Edit')}</button><button className="nw-icon" aria-label={t('删除主机', 'Delete host')} disabled={busy} onClick={() => setDeleting(host)}><Trash2 size={15} /></button></div>)}</div>
    {sessions.filter(s => s.status === 'ready').map(session => <div className="nw-ssh-live" key={session.sessionId}><TerminalSquare size={16} /><span>{session.name}</span><button className="nw-button" onClick={() => onOpenSession?.(session)}>{t('打开终端', 'Open terminal')}</button><button className="nw-icon" aria-label={t('断开连接', 'Disconnect')} onClick={() => void action(() => request('ssh/close', { sessionId: session.sessionId }))}><X size={15} /></button></div>)}
    {editing && <Modal title={t('主机设置', 'Host settings')} close={() => setEditing(false)} busy={busy}><form className="nw-ssh-form" onSubmit={event => { event.preventDefault(); void action(async () => { await request('ssh/host/save', draft); setEditing(false); }); }}>
      <label className="nw-field">{t('名称', 'Name')}<input autoFocus required value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="nw-field">{t('服务器地址', 'Server address')}<input required value={draft.hostname || ''} onChange={e => setDraft({ ...draft, hostname: e.target.value })} /></label>
      <div className="nw-ssh-columns"><label className="nw-field">{t('用户名', 'Username')}<input required autoComplete="off" value={draft.username || ''} onChange={e => setDraft({ ...draft, username: e.target.value })} /></label><label className="nw-field">{t('端口', 'Port')}<input type="number" min={1} max={65535} required value={draft.port || 22} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label></div>
      <label className="nw-field">{t('登录方式', 'Authentication')}<select value={draft.auth} onChange={e => setDraft({ ...draft, auth: e.target.value as SshHost['auth'] })}><option value="agent">{t('系统 SSH Agent', 'System SSH agent')}</option><option value="privateKey">{t('私钥文件', 'Private key file')}</option><option value="password">{t('密码', 'Password')}</option></select></label>
      {draft.auth === 'privateKey' && <label className="nw-field">{t('私钥文件完整路径', 'Full private key path')}<input required value={draft.keyPath || ''} onChange={e => setDraft({ ...draft, keyPath: e.target.value })} /></label>}
      <label className="nw-field">{t('远程目录（可选）', 'Remote directory (optional)')}<input placeholder={t('/home/user/project', '/home/user/project')} value={draft.root || ''} onChange={e => setDraft({ ...draft, root: e.target.value })} /></label><p className="nw-help">{t('密码与私钥口令在连接时输入，仅用于本次连接。', 'Enter passwords and key passphrases when connecting; they remain in memory for that connection.')}</p><button className="nw-button nw-button-primary" disabled={busy}>{t('保存主机', 'Save host')}</button>
    </form></Modal>}
    {connectHost && <Modal title={connectHost.name} close={cancelConnect}><div className="nw-ssh-form">
      {connectHost.auth !== 'agent' && <label className="nw-field"><KeyRound size={14} />{connectHost.auth === 'password' ? t('密码', 'Password') : t('私钥口令（可选）', 'Key passphrase (optional)')}<input type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} /></label>}
      {challenges.filter(c => c.hostId === connectHost.id).map(challenge => <div className="nw-ssh-trust" key={challenge.fingerprint}><ShieldCheck size={20} /><strong>{challenge.previousFingerprint ? t('服务器指纹发生变化', 'Server fingerprint changed') : t('确认服务器身份', 'Verify server identity')}</strong><code>{challenge.fingerprint}</code><p>{t('请与服务器管理员提供的指纹核对。', 'Compare this fingerprint with the one provided by the server administrator.')}</p><button className="nw-button" disabled={busy} onClick={() => void action(async () => { await request('ssh/host/trust', { id: connectHost.id, revision: challenge.revision, fingerprint: challenge.fingerprint, replace: Boolean(challenge.previousFingerprint) }); })}>{t('信任此指纹', 'Trust this fingerprint')}</button></div>)}
      {error && <p role="alert" className="nw-inline-error">{error}</p>}<button className="nw-button nw-button-primary" disabled={busy} onClick={() => void connect(connectHost)}>{busy ? t('正在连接…', 'Connecting…') : t('连接', 'Connect')}</button>
    </div></Modal>}
    {deleting && <Modal title={t('删除主机', 'Delete host')} close={() => setDeleting(undefined)} busy={busy}><p>{t(`删除“${deleting.name}”的连接配置？服务器上的文件会保留。`, `Delete the connection settings for “${deleting.name}”? Files on the server will remain.`)}</p><div className="nw-dialog-actions"><button className="nw-button" disabled={busy} onClick={() => setDeleting(undefined)}>{t('取消', 'Cancel')}</button><button className="nw-button" disabled={busy} onClick={() => void action(async () => { await request('ssh/host/delete', { id: deleting.id, revision: deleting.revision }); setDeleting(undefined); })}>{t('删除', 'Delete')}</button></div></Modal>}
  </section>;
}
