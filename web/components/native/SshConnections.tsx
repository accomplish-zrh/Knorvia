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
  const [draftSecret, setDraftSecret] = useState(''), [revealSecret, setRevealSecret] = useState(false), [dropSecret, setDropSecret] = useState(false);
  const [jumpSecret, setJumpSecret] = useState('');
  const [connectHost, setConnectHost] = useState<SshHost>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SshHost>();
  const pending = useRef<string | undefined>(undefined);
  const openEditor = (host?: SshHost) => { setDraft(host || blank); setDraftSecret(''); setRevealSecret(false); setDropSecret(false); setEditing(true); };
  const load = useCallback(async () => {
    const [catalog, active] = await Promise.all([request<{ hosts: SshHost[]; pendingTrust: SshChallenge[] }>('ssh/host/list', {}), request<SshSession[]>('ssh/list', {})]);
    setHosts(catalog.hosts); setChallenges(catalog.pendingTrust); setSessions(active);
  }, [request]);
  useEffect(() => { if (connection === 'connected') { setError(''); void load().catch(e => setError(errorText(e))); } }, [load, connection]);
  const action = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (e) { setError(errorText(e)); await load().catch(() => {}); } finally { setBusy(false); } };
  const connect = (host: SshHost) => action(async () => {
    const id = crypto.randomUUID(); pending.current = id;
    try { const result = await request<SshSession>('ssh/open', { sessionId: id, hostId: host.id, cols: 100, rows: 30, ...(secret ? { secret } : {}), ...(jumpSecret ? { jumpSecret } : {}) }); setConnectHost(undefined); setSecret(''); setJumpSecret(''); onOpenSession?.(result); }
    finally { pending.current = undefined; }
  });
  const cancelConnect = () => { if (pending.current) void request('ssh/close', { sessionId: pending.current }).catch(() => {}); setConnectHost(undefined); setSecret(''); setJumpSecret(''); };
  const jumpOfConnect = connectHost?.jumpHostId ? hosts.find(host => host.id === connectHost.jumpHostId) : undefined;
  return <section className="nw-ssh-settings">
    <div className="nw-page-heading"><div><h2><Server size={20} /> {t('SSH 连接', 'SSH connections')}</h2><p>{t('保存主机，在右侧终端连接远程工作目录。', 'Save a host and connect to its remote folder in the side terminal.')}</p></div><button className="nw-button" onClick={() => openEditor()}><Plus size={15} />{t('添加主机', 'Add host')}</button></div>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {!hosts.length && <p className="nw-help">{t('添加服务器地址与登录方式即可开始。首次连接会展示服务器指纹。', 'Add a server and authentication method. The first connection shows its fingerprint.')}</p>}
    <div className="nw-ssh-hosts">{hosts.map(host => <div className="nw-ssh-host" key={host.id}><Server size={19} /><div><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small><small>{host.root || t('远程主目录', 'Remote home')}</small>{host.jumpHostId && <small>{t('经跳板机连接', 'Connects through a jump host')}</small>}<small>{host.hasSecret ? t('已保存凭据', 'Credential saved') : t('未保存凭据', 'No saved credential')}</small></div><button className="nw-button" disabled={busy} onClick={() => { setConnectHost(host); setSecret(''); setJumpSecret(''); }}>{t('连接', 'Connect')}</button><button className="nw-button" disabled={busy} onClick={() => openEditor(host)}>{t('编辑', 'Edit')}</button><button className="nw-icon" aria-label={t('删除主机', 'Delete host')} disabled={busy} onClick={() => setDeleting(host)}><Trash2 size={15} /></button></div>)}</div>
    {sessions.filter(s => s.status === 'ready').map(session => <div className="nw-ssh-live" key={session.sessionId}><TerminalSquare size={16} /><span>{session.name}</span><button className="nw-button" onClick={() => onOpenSession?.(session)}>{t('打开终端', 'Open terminal')}</button><button className="nw-icon" aria-label={t('断开连接', 'Disconnect')} onClick={() => void action(() => request('ssh/close', { sessionId: session.sessionId }))}><X size={15} /></button></div>)}
    {editing && <Modal title={t('主机设置', 'Host settings')} close={() => setEditing(false)} busy={busy}><form className="nw-ssh-form" onSubmit={event => { event.preventDefault(); void action(async () => { await request('ssh/host/save', { ...draft, ...(draftSecret ? { secret: draftSecret } : {}), ...(dropSecret ? { clearSecret: true } : {}) }); setEditing(false); }); }}>
      <label className="nw-field">{t('名称', 'Name')}<input autoFocus required value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="nw-field">{t('服务器地址', 'Server address')}<input required value={draft.hostname || ''} onChange={e => setDraft({ ...draft, hostname: e.target.value })} /></label>
      <div className="nw-ssh-columns"><label className="nw-field">{t('用户名', 'Username')}<input required autoComplete="off" value={draft.username || ''} onChange={e => setDraft({ ...draft, username: e.target.value })} /></label><label className="nw-field">{t('端口', 'Port')}<input type="number" min={1} max={65535} required value={draft.port || 22} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label></div>
      <label className="nw-field">{t('登录方式', 'Authentication')}<select value={draft.auth} onChange={e => setDraft({ ...draft, auth: e.target.value as SshHost['auth'] })}><option value="agent">{t('系统 SSH Agent', 'System SSH agent')}</option><option value="privateKey">{t('私钥文件', 'Private key file')}</option><option value="password">{t('密码', 'Password')}</option></select></label>
      {draft.auth === 'privateKey' && <label className="nw-field">{t('私钥文件完整路径', 'Full private key path')}<input required value={draft.keyPath || ''} onChange={e => setDraft({ ...draft, keyPath: e.target.value })} /></label>}
      {(draft.auth === 'password' || draft.auth === 'privateKey') && <>
        <label className="nw-field">{draft.auth === 'password' ? t('密码', 'Password') : t('私钥口令（可选）', 'Key passphrase (optional)')}<input type={revealSecret ? 'text' : 'password'} autoComplete="new-password" value={draftSecret} placeholder={draft.hasSecret && !dropSecret ? t('已保存 · 留空则保持不变', 'Saved · leave blank to keep it') : undefined} onChange={e => { setDraftSecret(e.target.value); setDropSecret(false); }} /></label>
        <label className="nw-ssh-secret-option"><input type="checkbox" aria-label={t('显示密码', 'Show password')} checked={revealSecret} onChange={e => setRevealSecret(e.target.checked)} />{t('显示密码', 'Show password')}</label>
        {draft.hasSecret && <label className="nw-ssh-secret-option"><input type="checkbox" aria-label={t('清除已保存的密码', 'Clear the saved password')} checked={dropSecret} onChange={e => { setDropSecret(e.target.checked); if (e.target.checked) setDraftSecret(''); }} />{t('清除已保存的密码', 'Clear the saved password')}</label>}
      </>}
      <label className="nw-field">{t('远程目录（可选）', 'Remote directory (optional)')}<input placeholder={t('/home/user/project', '/home/user/project')} value={draft.root || ''} onChange={e => setDraft({ ...draft, root: e.target.value })} /></label>
      <label className="nw-field">{t('跳板机（可选，单跳）', 'Jump host (optional, one hop)')}<select value={draft.jumpHostId || ''} onChange={e => setDraft({ ...draft, jumpHostId: e.target.value || undefined })}><option value="">{t('直连', 'Direct connection')}</option>{hosts.filter(h => h.id !== draft.id && !h.jumpHostId).map(h => <option key={h.id} value={h.id}>{h.name} ({h.hostname})</option>)}</select></label>
      <p className="nw-help">{t('通过跳板机时，跳板与目标各自核对指纹；两端的凭据可以保存，也可以在连接时输入。关闭会话会同时断开两端。', 'Through a jump host, bastion and target each verify their own fingerprint; either side can use a saved credential or one typed at connect time. Closing the session tears down both hops.')}</p><button className="nw-button nw-button-primary" disabled={busy}>{t('保存主机', 'Save host')}</button>
    </form></Modal>}
    {connectHost && <Modal title={connectHost.name} close={cancelConnect}><div className="nw-ssh-form">
      {connectHost.jumpHostId && <p className="nw-help">{t('此主机经跳板机连接：跳板与目标会分别出示指纹。', 'This host connects through a jump host: bastion and target each present their own fingerprint.')}</p>}
      {connectHost.auth !== 'agent' && <label className="nw-field"><KeyRound size={14} />{connectHost.auth === 'password' ? t('密码', 'Password') : t('私钥口令（可选）', 'Key passphrase (optional)')}<input type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} /></label>}
      {jumpOfConnect && jumpOfConnect.auth !== 'agent' && <label className="nw-field"><KeyRound size={14} />{t('跳板机', 'Jump host')} {jumpOfConnect.name} · {jumpOfConnect.auth === 'password' ? t('密码', 'Password') : t('私钥口令（可选）', 'Key passphrase (optional)')}<input type="password" autoComplete="off" placeholder={jumpOfConnect.hasSecret ? t('已保存 · 留空使用已保存的密码', 'Saved · leave blank to use it') : t('仅用于本次连接，不会被保存', 'Used for this connection only, never saved')} value={jumpSecret} onChange={e => setJumpSecret(e.target.value)} /></label>}
      {[connectHost.jumpHostId, connectHost.id].filter(Boolean).map(hostId => challenges.filter(c => c.hostId === hostId).map(challenge => {
        const challengeHost = hosts.find(h => h.id === hostId);
        return <div className="nw-ssh-trust" key={challenge.fingerprint}><ShieldCheck size={20} /><strong>{challengeHost ? `${challengeHost.name}: ` : ''}{challenge.previousFingerprint ? t('服务器指纹发生变化', 'Server fingerprint changed') : t('确认服务器身份', 'Verify server identity')}</strong><code>{challenge.fingerprint}</code><p>{t('请与服务器管理员提供的指纹核对。', 'Compare this fingerprint with the one provided by the server administrator.')}</p><button className="nw-button" disabled={busy} onClick={() => void action(async () => { await request('ssh/host/trust', { id: hostId, revision: challenge.revision, fingerprint: challenge.fingerprint, replace: Boolean(challenge.previousFingerprint) }); })}>{t('信任此指纹', 'Trust this fingerprint')}</button></div>;
      }))}
      {error && <p role="alert" className="nw-inline-error">{error}</p>}<button className="nw-button nw-button-primary" disabled={busy} onClick={() => void connect(connectHost)}>{busy ? t('正在连接…', 'Connecting…') : t('连接', 'Connect')}</button>
    </div></Modal>}
    {deleting && <Modal title={t('删除主机', 'Delete host')} close={() => setDeleting(undefined)} busy={busy}><p>{t(`删除“${deleting.name}”的连接配置？服务器上的文件会保留。`, `Delete the connection settings for “${deleting.name}”? Files on the server will remain.`)}</p><div className="nw-dialog-actions"><button className="nw-button" disabled={busy} onClick={() => setDeleting(undefined)}>{t('取消', 'Cancel')}</button><button className="nw-button" disabled={busy} onClick={() => void action(async () => { await request('ssh/host/delete', { id: deleting.id, revision: deleting.revision }); setDeleting(undefined); })}>{t('删除', 'Delete')}</button></div></Modal>}
  </section>;
}
