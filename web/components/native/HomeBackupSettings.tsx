"use client";
import { useCallback, useEffect, useState } from 'react';
import { Check, DatabaseBackup, HardDriveDownload, Loader2, X } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

// C09: full offline Home backup and verified restore. While the app is
// running, only the plan can be previewed; the export itself runs during the
// bounded shutdown when every writer has exited, so a consistent copy is
// never faked. Restore always targets a brand-new directory and verifies the
// whole backup before touching anything.
type BackupPlan = {
  components: { name: string; files: number; bytes: number; note: string; requiresReloginOnOtherMachine?: boolean }[];
  totalFiles: number;
  totalBytes: number;
  warnings: string[];
  busyLocks: string[];
  canExportNow: boolean;
  requiresSafeShutdown: boolean;
};
type RestorePreview = {
  ok: boolean;
  problems?: string[];
  components?: { name: string; note?: string }[];
  totalFiles?: number;
  totalBytes?: number;
  createdAt?: string;
  appVersion?: string;
  warnings?: string[];
};
type BackupStatus = { unavailableReason?: string; pending?: { destination: string } | null; lastResult?: { ok?: boolean; error?: string; destination?: string; at?: string } | null };

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;

export function HomeBackupSettings() {
  const { request, connection, t, setNotice } = useWorkbench();
  const [plan, setPlan] = useState<BackupPlan>();
  const [status, setStatus] = useState<BackupStatus>();
  const [destination, setDestination] = useState('');
  const [restoreDir, setRestoreDir] = useState('');
  const [restoreTarget, setRestoreTarget] = useState('');
  const [preview, setPreview] = useState<RestorePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (connection !== 'connected') return;
    try {
      setPlan(await request<BackupPlan>('home/backup/plan'));
      setStatus(await request<BackupStatus>('home/backup/status'));
    } catch (cause) { setError(errorText(cause)); }
  }, [request, connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <section className="nw-preference-section nw-home-backup"><h2>{t('备份与恢复', 'Backup and restore')}</h2>
    <p className="nw-help">{t('备份包含设置、资料库（含历史）、任务记录与扩展。为保证数据一致，备份在应用完全退出时执行；凭据以加密形式复制，换电脑后需要重新登录。恢复总是写入一个全新的空目录，不会覆盖现有数据。', 'Backups include settings, the library (with history), task records and extensions. For consistency, the export runs while the app fully exits. Credentials are copied encrypted and need a new sign-in on another machine. Restore always writes into a brand-new empty directory and never overwrites existing data.')}</p>
    {plan && <div className="nw-preference-card">
      {plan.components.map((component) => <div className="nw-preference-row" key={component.name}>
        <div><strong>{component.name}</strong><p>{component.note}{component.requiresReloginOnOtherMachine ? ` · ${t('含加密凭据', 'contains encrypted credentials')}` : ''}</p></div>
        <div className="nw-preference-control"><span className="nw-muted-label">{component.files} {t('个文件', 'files')} · {mb(component.bytes)}</span></div>
      </div>)}
      <div className="nw-preference-row"><div><strong>{t('合计', 'Total')}</strong><p>{plan.totalFiles} {t('个文件', 'files')} · {mb(plan.totalBytes)}</p></div></div>
      {plan.warnings.length > 0 && <p className="nw-help">{plan.warnings.join('；')}</p>}
    </div>}
    <div className="nw-preference-actions">
      <button className="nw-button" disabled={busy || connection !== 'connected'} onClick={() => run(refresh)}><Loader2 size={14} className={busy ? 'nw-spin' : ''} />{t('重新计算', 'Recalculate')}</button>
      <label className="nw-field">{t('备份位置（新目录）', 'Backup destination (a new folder)')}
        <input value={destination} placeholder="D:\\backup\\knorvia-home" onChange={(event) => setDestination(event.target.value)} />
      </label>
      {status?.pending
        ? <button className="nw-button" disabled={busy} onClick={() => run(async () => { await request('home/backup/cancel', {}); setStatus(await request<BackupStatus>('home/backup/status')); setNotice(t('已取消计划备份。', 'Scheduled backup cancelled.')); })}><X size={14} />{t('取消退出时备份', 'Cancel shutdown backup')}</button>
        : <button className="nw-button nw-button-primary" disabled={busy || !destination.trim() || Boolean(status?.unavailableReason)} onClick={() => run(async () => { await request('home/backup/schedule', { destination: destination.trim() }); setStatus(await request<BackupStatus>('home/backup/status')); setNotice(t('已计划：退出应用时执行备份。', 'Scheduled: the export runs when the app exits.')); })}><DatabaseBackup size={14} />{t('退出时备份到此处', 'Back up here on exit')}</button>}
    </div>
    {status?.pending && <p className="nw-help" role="status">{status.unavailableReason ? t('已保留的备份目标', 'Retained backup destination') : t('将于完全退出时备份到', 'Will be backed up on exit to')} {status.pending.destination}</p>}
    {status?.unavailableReason && <p className="nw-help" role="status">{t('本版本暂不支持退出时自动备份，已有待办已保留。', 'Automatic backup on exit is unavailable in this version. Existing requests are retained.')}</p>}
    {status?.lastResult && <p className="nw-help" role={status.lastResult.ok ? 'status' : 'alert'}>{status.lastResult.ok ? `${t('上次备份完成', 'Last backup finished')}: ${status.lastResult.destination}` : `${t('上次备份失败', 'Last backup failed')}: ${status.lastResult.error}`}</p>}
    <h2 className="nw-section-subheading">{t('从备份恢复', 'Restore from a backup')}</h2>
    <div className="nw-preference-card"><p className="nw-help">{t('先校验备份目录，再恢复到一个全新的空目录；完成后可在下次启动时使用该 Home。', 'Verify a backup folder first, restore it into a brand-new empty directory, and optionally use that Home on the next start.')}</p>
      <label className="nw-field">{t('备份目录', 'Backup folder')}<input value={restoreDir} onChange={(event) => { setRestoreDir(event.target.value); setPreview(undefined); }} /></label>
      <div className="nw-preference-actions">
        <button className="nw-button" disabled={busy || !restoreDir.trim()} onClick={() => run(async () => { setPreview(await request<RestorePreview>('home/restore/preview', { backupDir: restoreDir.trim() })); })}><Check size={14} />{t('校验并预览', 'Verify and preview')}</button>
        <label className="nw-field">{t('新 Home 位置（空目录）', 'New Home location (empty folder)')}<input value={restoreTarget} onChange={(event) => setRestoreTarget(event.target.value)} /></label>
        <button className="nw-button nw-button-primary" disabled={busy || !preview?.ok || !restoreTarget.trim()} onClick={() => run(async () => { await request('home/restore/perform', { backupDir: restoreDir.trim(), targetHome: restoreTarget.trim(), switchOnNextStart: true }); setNotice(t('恢复完成。下次启动将使用新的 Home。', 'Restore complete. The next start uses the new Home.')); })}><HardDriveDownload size={14} />{t('恢复到新目录', 'Restore to new directory')}</button>
      </div>
      {preview && (preview.ok
        ? <p className="nw-help" role="status">{t('备份有效：%1 个文件，创建于 %2。', 'Backup is valid: %1 files, created %2.').replace('%1', String(preview.totalFiles ?? 0)).replace('%2', preview.createdAt || '')}</p>
        : <p className="nw-inline-error" role="alert">{preview.problems?.join('；')}</p>)}
    </div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
