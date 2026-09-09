'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, File, Folder, RefreshCw, Upload, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './ssh.css';
type RemoteEntry = { name: string; kind: 'directory' | 'file' | 'symlink'; size: number };
export function SshFilesPanel({ sessionId, workspaceId: requestedWorkspace, threadId }: { sessionId: string; workspaceId?: string; threadId?: string }) {
  const { request, t, workspaceId, workspaces } = useWorkbench();
  const [folder, setFolder] = useState(''), [entries, setEntries] = useState<RemoteEntry[]>([]), [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState(''), [preview, setPreview] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [project, setProject] = useState(requestedWorkspace || workspaceId), [localPath, setLocalPath] = useState(''), [remoteName, setRemoteName] = useState(''), [localDirectory, setLocalDirectory] = useState('');
  const scope = threadId ? { threadId } : { workspaceId: project };
  const join = (name: string) => folder ? `${folder}/${name}` : name;
  const load = useCallback(async () => { const result = await request<{ entries: RemoteEntry[]; truncated: boolean }>('ssh/files/list', { sessionId, path: folder }); setEntries(result.entries); setTruncated(result.truncated); }, [folder, request, sessionId]);
  useEffect(() => { setSelected(''); setPreview(''); void load().catch(e => setError(errorText(e))); }, [load]);
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  return <section className="nw-ssh-files" aria-label={t('远程文件', 'Remote files')}>
    <header><button className="nw-icon" disabled={!folder || busy} aria-label={t('返回上级目录', 'Parent folder')} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}><ArrowLeft size={15} /></button><strong>{folder || t('远程目录', 'Remote folder')}</strong><button className="nw-icon" disabled={busy} aria-label={t('刷新文件', 'Refresh files')} onClick={() => void action(load)}><RefreshCw size={15} /></button></header>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}{notice && <p role="status" className="nw-help">{notice}</p>}
    <div className="nw-ssh-file-list">{entries.map(entry => <button key={entry.name} disabled={busy} className={selected === join(entry.name) ? 'is-active' : ''} onClick={() => { if (entry.kind === 'directory') setFolder(join(entry.name)); else void action(async () => { const name = join(entry.name); setSelected(name); setPreview(''); const value = await request<{ content: string | null; binary: boolean }>('ssh/files/read', { sessionId, path: name }); setPreview(value.binary ? t('二进制文件，可下载后打开。', 'Binary file. Download it to open locally.') : value.content || t('空文件', 'Empty file')); }); }}>{entry.kind === 'directory' ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span><small>{entry.kind === 'directory' ? '' : `${(entry.size / 1024).toFixed(1)} KB`}</small></button>)}</div>
    {truncated && <p className="nw-help">{t('仅展示前 500 项，请进入具体目录。', 'Showing the first 500 entries. Open a subfolder to narrow the list.')}</p>}
    {selected && <div className="nw-ssh-preview"><header><strong>{selected}</strong><button className="nw-icon" aria-label={t('关闭预览', 'Close preview')} onClick={() => { setSelected(''); setPreview(''); }}><X size={14} /></button></header><pre>{preview}</pre></div>}
    <details><summary>{t('传输文件', 'Transfer files')}</summary><div className="nw-ssh-transfer">
      {!threadId && <label className="nw-field">{t('本地项目', 'Local project')}<select value={project} onChange={e => setProject(e.target.value)}><option value="">{t('选择项目', 'Choose project')}</option>{workspaces.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
      <label className="nw-field">{t('上传：项目内文件路径', 'Upload: file path within the project')}<input value={localPath} onChange={e => setLocalPath(e.target.value)} /></label><label className="nw-field">{t('远程文件名', 'Remote filename')}<input value={remoteName} onChange={e => setRemoteName(e.target.value)} /></label><button className="nw-button" disabled={busy || (!threadId && !project) || !localPath || !remoteName} onClick={() => void action(async () => { await request('ssh/files/upload', { sessionId, ...scope, localPath, path: join(remoteName) }); setNotice(t('文件已上传。', 'File uploaded.')); await load(); })}><Upload size={14} />{t('上传到当前目录', 'Upload to this folder')}</button>
      <label className="nw-field">{t('下载：项目内保存目录', 'Download: folder within the project')}<input value={localDirectory} onChange={e => setLocalDirectory(e.target.value)} /></label><button className="nw-button" disabled={busy || !selected || (!threadId && !project)} onClick={() => void action(async () => { await request('ssh/files/download', { sessionId, ...scope, path: selected, localDirectory }); setNotice(t('文件已保存到本地项目。', 'File saved to the local project.')); })}><ArrowDownToLine size={14} />{t('下载选中文件', 'Download selected file')}</button><p className="nw-help">{t('单文件上限 16 MB，同名文件会保留。中断连接会停止传输。', 'Up to 16 MB per file. Existing files are preserved. Disconnecting stops transfers.')}</p>
    </div></details>
  </section>;
}
