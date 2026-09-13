"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FolderOpen, Loader2, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

// C08: in-app update download with progress, cancellation and SHA-256
// verification. The installer is never launched automatically; a verified
// package can be revealed in its folder, an unverified one only offers the
// release page.
type DownloadStatusPayload = { managerAvailable: boolean; unavailableError: string | null; task: DownloadTask | null };
type DownloadTask = {
  id: string;
  name: string;
  version?: string;
  verified: boolean;
  state: "downloading" | "cancelled" | "failed" | "published" | "cancelling";
  receivedBytes: number;
  totalBytes: number;
  publishedPath: string;
  error: string;
};
type UpdateDecision = {
  kind: string;
  release?: { version: string; url: string };
  installer?: { url: string; name: string; size: number; digest?: string } | null;
  downloadUrl?: string;
  downloadHint?: string;
  message?: string;
};

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;

export function UpdateDownloadSettings() {
  const { connection, t, setNotice } = useWorkbench();
  const [decision, setDecision] = useState<UpdateDecision>();
  const [task, setTask] = useState<DownloadTask>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const poll = useRef<ReturnType<typeof setInterval>>(null);
  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.knorviaDesktop?.update?.downloadStatus();
      setTask(status?.task ?? undefined);
      return status?.task ?? null;
    } catch { return null; }
  }, []);
  useEffect(() => {
    if (connection !== 'connected') return;
    void refreshStatus();
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [connection, refreshStatus]);
  useEffect(() => {
    const downloading = task?.state === 'downloading' || task?.state === 'cancelling';
    if (downloading && !poll.current) {
      poll.current = setInterval(() => {
        void refreshStatus().then((status) => {
          if (status && status.state !== 'downloading' && status.state !== 'cancelling') {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
          }
        });
      }, 500);
    }
    if (!downloading && poll.current) { clearInterval(poll.current); poll.current = null; }
  }, [task?.state, refreshStatus]);
  const run = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); } catch (cause) { setError(errorText(cause)); }
  };
  return <section className="nw-preference-section nw-update-download"><h2>{t('应用内更新', 'In-app updates')}</h2>
    <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('下载目录', 'Download directory')}</strong>
        <p>{t('默认使用系统下载目录中的 Knorvia 文件夹；不可用时可以选择其他目录。', 'Uses a Knorvia folder inside the system downloads directory; pick another directory when unavailable.')}</p></div>
        <div className="nw-preference-control">
          <button className="nw-button" disabled={connection !== 'connected'} onClick={() => void run(async () => {
            const outcome = await window.knorviaDesktop!.update!.chooseDownloadDir();
            if (outcome.ok) { setNotice(t('下载目录已更新。', 'Download directory updated.')); void refreshStatus(); }
            else if (outcome.error !== 'canceled') setError(outcome.error || t('无法选择下载目录。', 'Could not choose a download directory.'));
          })}>{t('选择下载目录', 'Choose directory')}</button>
        </div>
      </div>
    </div>
    <p className="nw-help">{t('在应用内下载安装包：可以查看进度、随时取消；下载完成后会校验发布摘要，校验通过才提供打开位置。应用不会自动安装。', 'Download installers inside the app with progress and cancellation. Completed downloads are verified against the published digest; only verified packages offer "show in folder". The app never installs automatically.')}</p>
    <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('检查更新', 'Check for updates')}</strong><p>{decision?.kind === 'available' ? t('有新版本 %1', 'New version %1 available').replace('%1', decision.release?.version || '') : decision?.kind === 'up-to-date' ? t('已是最新版本', 'You are up to date') : decision?.message || t('在 GitHub 上检查新版本', 'Check GitHub for a new version')}</p></div>
        <div className="nw-preference-control">
          <button className="nw-button" disabled={checking || connection !== 'connected'} onClick={() => run(async () => { setChecking(true); try { setDecision(await window.knorviaDesktop!.update!.check() as UpdateDecision); } finally { setChecking(false); } })}>
            {checking ? <Loader2 size={15} className="nw-spin" /> : null}{t('检查', 'Check')}
          </button>
        </div>
      </div>
      {task && <div className="nw-preference-row"><div><strong>{t('下载任务', 'Download task')}</strong>
        <p>{task.state === 'downloading' ? `${mb(task.receivedBytes)} / ${task.totalBytes ? mb(task.totalBytes) : '?'}` : task.state === 'published' ? (task.verified ? t('已下载并通过校验', 'Downloaded and verified') : t('已下载（未校验：发布未提供摘要）', 'Downloaded (unverified: the release declares no digest)')) : task.state === 'cancelled' ? t('已取消', 'Cancelled') : task.error || task.state}</p>
      </div>
        <div className="nw-preference-control">
          {task.state === 'downloading' && <button className="nw-button" onClick={() => run(() => window.knorviaDesktop!.update!.cancelDownload())}><X size={14} />{t('取消下载', 'Cancel download')}</button>}
          {task.state === 'published' && task.verified && <button className="nw-button" onClick={() => run(() => window.knorviaDesktop!.update!.openDownload())}><FolderOpen size={14} />{t('打开位置', 'Show in folder')}</button>}
          {task.state === 'published' && !task.verified && <span className="nw-muted-label">{t('请从发布页重新获取安装包', 'Please fetch the installer from the release page')}</span>}
          {(task.state === 'failed' || task.state === 'cancelled') && <button className="nw-button" disabled={!decision?.installer} onClick={() => run(async () => { const outcome = await window.knorviaDesktop!.update!.startDownload({ url: decision!.installer!.url, name: decision!.installer!.name, version: decision!.release?.version, digest: decision!.installer!.digest || '', size: decision!.installer!.size }); if (!outcome.ok) setError(outcome.error || ''); else void refreshStatus(); })}><Download size={14} />{t('重新下载', 'Download again')}</button>}
        </div>
      </div>}
      {decision?.kind === 'available' && decision.installer && (!task || !['downloading', 'cancelling', 'published'].includes(task.state)) && <div className="nw-preference-row"><div><strong>{decision.release?.version}</strong></div><div className="nw-preference-control">
        <button className="nw-button nw-button-primary" onClick={() => run(async () => {
          const outcome = await window.knorviaDesktop!.update!.startDownload({ url: decision.installer!.url, name: decision.installer!.name, version: decision.release?.version, digest: decision.installer!.digest || '', size: decision.installer!.size });
          if (!outcome.ok) setError(outcome.error || ''); else { setTask(outcome.task || undefined); setNotice(t('下载已开始', 'Download started')); void refreshStatus(); }
        })}><Download size={14} />{t('下载安装包', 'Download installer')}</button>
      </div></div>}
      {decision?.kind === 'available' && !decision.installer && decision.downloadHint && <p className="nw-help">{decision.downloadHint}</p>}
    </div>
    {decision?.release?.url && <p><a className="nw-setting-link" href={decision.release.url} target="_blank" rel="noreferrer">{t('打开发布页', 'Open the release page')}<ExternalLink size={14} /></a></p>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
