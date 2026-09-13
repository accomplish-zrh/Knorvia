'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, File, Folder, RefreshCw, Upload, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './ssh.css';
type RemoteEntry = { name: string; kind: 'directory' | 'file' | 'symlink'; size: number };
type ListPage = { entries: RemoteEntry[]; cursor: string | null; hasMore: boolean; truncated?: boolean };
type Transfer = { transferId: string; direction: 'upload' | 'download'; name: string; bytesTotal: number; bytesDone: number; status: 'running' | 'completed' | 'failed' | 'canceled' | 'detached'; stage?: string; error: string };
export function SshFilesPanel({ sessionId, workspaceId: requestedWorkspace, threadId }: { sessionId: string; workspaceId?: string; threadId?: string }) {
  const { request, t, workspaceId, workspaces } = useWorkbench();
  const [folder, setFolder] = useState(''), [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [loadingMore, setLoadingMore] = useState(false);
  // Request generation: responses from superseded requests (folder switched,
  // refresh clicked) are discarded instead of polluting the current list.
  const loadSeq = useRef(0);
  // Set when the server told us entries were dropped (oversized single
  // batch): the tail notice must say "incomplete", never "all shown".
  const [incomplete, setIncomplete] = useState(false);
  const [selected, setSelected] = useState(''), [preview, setPreview] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [project, setProject] = useState(requestedWorkspace || workspaceId), [localPath, setLocalPath] = useState(''), [remoteName, setRemoteName] = useState(''), [localDirectory, setLocalDirectory] = useState('');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const scope = threadId ? { threadId } : { workspaceId: project };
  const join = (name: string) => folder ? `${folder}/${name}` : name;
  // The listing is cursor-paginated on the desktop host: each page holds a
  // bounded batch and keeps the remote directory handle alive until the last
  // page, an explicit refresh, a folder change or a cancel releases it.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const result = await request<ListPage>('ssh/files/list', { sessionId, path: folder });
    if (seq !== loadSeq.current) return;
    setEntries(result.entries);
    setCursor(result.cursor);
    setHasMore(result.hasMore);
    setIncomplete(result.truncated === true);
  }, [folder, request, sessionId]);
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const seq = ++loadSeq.current;
    const requestedCursor = cursor, requestedFolder = folder;
    const result = await request<ListPage>('ssh/files/list', { sessionId, path: requestedFolder, cursor: requestedCursor });
    if (seq !== loadSeq.current) {
      // A folder switch or refresh superseded this page: release the remote
      // handle it was consuming and never merge it into the new list.
      void request('ssh/files/list', { sessionId, path: requestedFolder, cursor: requestedCursor, cancel: true }).catch(() => {});
      return;
    }
    setEntries(prev => [...prev, ...result.entries]);
    setCursor(result.cursor);
    setHasMore(result.hasMore);
    if (result.truncated === true) setIncomplete(true);
  }, [cursor, folder, request, sessionId]);
  useEffect(() => { setSelected(''); setPreview(''); setIncomplete(false); void load().catch(e => setError(errorText(e))); }, [load]);
  // Leaving a folder mid-listing abandons the server-side handle promptly.
  useEffect(() => () => { if (cursor) void request('ssh/files/list', { sessionId, path: folder, cursor, cancel: true }).catch(() => {}); }, [cursor, folder, sessionId, request]);
  // One refresh per active session generation. A delayed request from an
  // old session or an unmounted panel must never publish into the current UI.
  const transferContext = useRef({ generation: 0, sessionId: '', mounted: false });
  const transferPending = useRef(new Set<number>());
  const transferRefreshAgain = useRef(new Set<number>());
  const refreshTransfers = useCallback(async (): Promise<void> => {
    const context = transferContext.current;
    if (!context.mounted || context.sessionId !== sessionId) return;
    if (transferPending.current.has(context.generation)) {
      transferRefreshAgain.current.add(context.generation);
      return;
    }
    const generation = context.generation;
    transferPending.current.add(generation);
    try {
      const result = await request<{ transfers: Transfer[] }>('ssh/transfer/list', { sessionId });
      const current = transferContext.current;
      if (!current.mounted || current.generation !== generation || current.sessionId !== sessionId) return;
      setTransfers(result.transfers);
    } catch { /* session ending: the transfer list dies with it */ }
    finally {
      transferPending.current.delete(generation);
      const again = transferRefreshAgain.current.delete(generation);
      const current = transferContext.current;
      if (again && current.mounted && current.generation === generation && current.sessionId === sessionId) {
        void refreshTransfers();
      }
    }
  }, [request, sessionId]);
  useEffect(() => {
    const generation = transferContext.current.generation + 1;
    transferContext.current = { generation, sessionId, mounted: true };
    setTransfers([]);
    void refreshTransfers();
    return () => {
      if (transferContext.current.generation === generation) {
        transferContext.current = { generation: generation + 1, sessionId, mounted: false };
      }
    };
  }, [refreshTransfers, sessionId]);
  const hasRunningTransfers = transfers.some(x => x.status === 'running');
  useEffect(() => {
    if (!hasRunningTransfers) return;
    const timer = setInterval(() => void refreshTransfers(), 700);
    return () => clearInterval(timer);
  }, [refreshTransfers, hasRunningTransfers]);
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const loadMoreAction = async () => { setLoadingMore(true); setError(''); try { await loadMore(); } catch (e) { setError(errorText(e)); } finally { setLoadingMore(false); } };
  const percent = (x: Transfer) => x.bytesTotal > 0 ? Math.min(100, Math.round((x.bytesDone / x.bytesTotal) * 100)) : 0;
  const transferLabel = (x: Transfer) => x.status === 'running' ? `${x.direction === 'upload' ? t('上传', 'Upload') : t('下载', 'Download')} · ${percent(x)}%`
    : x.status === 'completed' ? t('已完成', 'Done')
    : x.status === 'canceled' ? t('已取消', 'Cancelled')
    : x.status === 'detached' ? t('连接中断，未完成', 'Disconnected, incomplete')
    : t('失败', 'Failed');
  return <section className="nw-ssh-files" aria-label={t('远程文件', 'Remote files')}>
    <header><button className="nw-icon" disabled={!folder || busy} aria-label={t('返回上级目录', 'Parent folder')} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}><ArrowLeft size={15} /></button><strong>{folder || t('远程目录', 'Remote folder')}</strong><button className="nw-icon" disabled={busy} aria-label={t('刷新文件', 'Refresh files')} onClick={() => void action(load)}><RefreshCw size={15} /></button></header>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}{notice && <p role="status" className="nw-help">{notice}</p>}
    <div className="nw-ssh-file-list">{entries.map(entry => <button key={entry.name} disabled={busy} className={selected === join(entry.name) ? 'is-active' : ''} onClick={() => { if (entry.kind === 'directory') setFolder(join(entry.name)); else void action(async () => { const name = join(entry.name); setSelected(name); setPreview(''); const value = await request<{ content: string | null; binary: boolean }>('ssh/files/read', { sessionId, path: name }); setPreview(value.binary ? t('二进制文件，可下载后打开。', 'Binary file. Download it to open locally.') : value.content || t('空文件', 'Empty file')); }); }}>{entry.kind === 'directory' ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span><small>{entry.kind === 'directory' ? '' : `${(entry.size / 1024).toFixed(1)} KB`}</small></button>)}</div>
    {hasMore && <button className="nw-button nw-ssh-load-more" disabled={busy || loadingMore} onClick={() => void loadMoreAction()}>{loadingMore ? t('加载中…', 'Loading…') : t('加载更多条目', 'Load more entries')}</button>}
    {!hasMore && incomplete && <p className="nw-inline-error" role="alert">{t('远程目录条目超出单批保留上限，此列表不完整。', 'The remote directory exceeded the per-batch retention cap. This listing is incomplete.')}</p>}
    {!hasMore && !incomplete && entries.length > 0 && <p className="nw-help">{t(`已显示全部 ${entries.length} 项。`, `Showing all ${entries.length} entries.`)}</p>}
    {selected && <div className="nw-ssh-preview"><header><strong>{selected}</strong><button className="nw-icon" aria-label={t('关闭预览', 'Close preview')} onClick={() => { setSelected(''); setPreview(''); }}><X size={14} /></button></header><pre>{preview}</pre></div>}
    {transfers.length > 0 && <div className="nw-ssh-transfers" aria-label={t('传输任务', 'Transfers')}>
      {transfers.map(x => <div key={x.transferId} className="nw-ssh-transfer-row">
        <span>{x.direction === 'upload' ? <Upload size={13} /> : <ArrowDownToLine size={13} />}{x.name}</span>
        <span>{transferLabel(x)}</span>
        {x.status === 'running'
          ? <button className="nw-icon" aria-label={t('取消此传输', 'Cancel this transfer')} onClick={() => void action(async () => { await request('ssh/transfer/cancel', { sessionId, transferId: x.transferId }); await refreshTransfers(); })}><X size={13} /></button>
          : null}
        {(x.status === 'failed' || x.status === 'canceled' || x.status === 'detached') && x.error ? <small>{x.error}</small> : null}
      </div>)}
      {transfers.some(x => x.status === 'detached') && <p className="nw-help">{t('连接中断的传输不会自动续传；请重新开始。', 'Transfers interrupted by a disconnect are not resumed; start them again.')}</p>}
    </div>}
    <details><summary>{t('传输文件', 'Transfer files')}</summary><div className="nw-ssh-transfer">
      {!threadId && <label className="nw-field">{t('本地项目', 'Local project')}<select value={project} onChange={e => setProject(e.target.value)}><option value="">{t('选择项目', 'Choose project')}</option>{workspaces.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
      <label className="nw-field">{t('上传：项目内文件路径', 'Upload: file path within the project')}<input value={localPath} onChange={e => setLocalPath(e.target.value)} /></label><label className="nw-field">{t('远程文件名', 'Remote filename')}<input value={remoteName} onChange={e => setRemoteName(e.target.value)} /></label><button className="nw-button" disabled={busy || (!threadId && !project) || !localPath || !remoteName} onClick={() => void action(async () => { await request('ssh/transfer/start', { sessionId, direction: 'upload', ...scope, path: join(remoteName), localPath }); setNotice(t('传输已开始，可在下方查看进度。', 'Transfer started; watch its progress below.')); await refreshTransfers(); })}><Upload size={14} />{t('流式上传到当前目录', 'Stream upload to this folder')}</button>
      <label className="nw-field">{t('下载：项目内保存目录', 'Download: folder within the project')}<input value={localDirectory} onChange={e => setLocalDirectory(e.target.value)} /></label><button className="nw-button" disabled={busy || !selected || (!threadId && !project)} onClick={() => void action(async () => { await request('ssh/transfer/start', { sessionId, direction: 'download', ...scope, path: selected, localDirectory }); setNotice(t('传输已开始，可在下方查看进度。', 'Transfer started; watch its progress below.')); await refreshTransfers(); })}><ArrowDownToLine size={14} />{t('流式下载选中文件', 'Stream download selected file')}</button><p className="nw-help">{t('传输按任务流式进行，可单独取消；同名文件会被保留，上传先暂存校验后发布。断线后传输未完成，需重新开始。', 'Transfers stream per task and can be cancelled individually. Existing files are preserved; uploads stage and verify before publishing. Disconnected transfers stay incomplete — start them again.')}</p>
    </div></details>
  </section>;
}
