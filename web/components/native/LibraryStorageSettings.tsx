"use client";
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

// C04: user-controlled library space management. Nothing is deleted by
// default or automatically: the user previews the reclaimable plan, then
// executes exactly that plan through its token; a stale token (the library
// changed meanwhile) is rejected by the engine and shown here.
type StoragePlan = {
  version: number;
  token: string;
  working: { bytes: number };
  keptLatestVersions: { bytes: number };
  history: { versions: number; bytes: number };
  trash: { items: number; bytes: number };
  orphans: { bytes: number };
  reclaimableBytes: number;
  deletions: Array<{ kind: string; path?: string; bytes: number }>;
};
type CleanupResult = { freedBytes: number; removedVersions: number; removedTrashItems: number };

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
const kb = (bytes: number) => `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;

export function LibraryStorageSettings() {
  const { request, connection, t, setNotice } = useWorkbench();
  const [plan, setPlan] = useState<StoragePlan>();
  const [previewing, setPreviewing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CleanupResult>();
  const refresh = useCallback(() => {
    if (connection !== 'connected') return;
    setPreviewing(true);
    request<StoragePlan>('library/storage/plan')
      .then(value => { setPlan(value); setResult(undefined); setError(''); })
      .catch(cause => setError(errorText(cause)))
      .finally(() => setPreviewing(false));
  }, [request, connection]);
  useEffect(refresh, [refresh]);
  const stale = Boolean(result) || Boolean(error);
  return <section className="nw-preference-section nw-library-storage"><h2>{t('资料库空间', 'Library storage')}</h2>
    <p className="nw-help">{t('历史版本与回收站会随使用累积。这里先给出可回收空间的预览，只有你确认后才会执行清理；当前文件和每个资料的最新版本始终保留。', 'History versions and the trash accumulate over time. Preview the reclaimable space first — cleanup runs only after you confirm. Working files and every entry’s latest version are always kept.')}</p>
    <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('当前文件', 'Working files')}</strong><p>{plan ? mb(plan.working.bytes) : ''}</p></div><div className="nw-preference-control"><span className="nw-muted-label">{t('始终保留', 'Always kept')}</span></div></div>
      <div className="nw-preference-row"><div><strong>{t('最新版本备份', 'Latest-version backups')}</strong><p>{plan ? mb(plan.keptLatestVersions.bytes) : ''}</p></div><div className="nw-preference-control"><span className="nw-muted-label">{t('始终保留', 'Always kept')}</span></div></div>
      <div className="nw-preference-row"><div><strong>{t('旧版本历史', 'Superseded history')}</strong><p>{plan ? t('%1 个旧版本 · %2', '%1 old versions · %2').replace('%1', String(plan.history.versions)).replace('%2', kb(plan.history.bytes)) : ''}</p></div></div>
      <div className="nw-preference-row"><div><strong>{t('回收站', 'Trash')}</strong><p>{plan ? t('%1 项 · %2', '%1 items · %2').replace('%1', String(plan.trash.items)).replace('%2', kb(plan.trash.bytes)) : ''}</p></div></div>
      {plan && plan.orphans.bytes > 0 && <div className="nw-preference-row"><div><strong>{t('上次中断的清理残留', 'Leftovers from an interrupted cleanup')}</strong><p>{kb(plan.orphans.bytes)}</p></div></div>}
    </div>
    <div className="nw-preference-actions">
      <button className="nw-button" onClick={refresh} disabled={previewing || connection !== 'connected'}>
        {previewing ? <Loader2 size={15} className="nw-spin" /> : null}
        {t('重新计算预览', 'Recalculate preview')}
      </button>
      <button className="nw-button" disabled={!plan || cleaning || previewing || plan.reclaimableBytes === 0 || stale}
        onClick={() => {
          if (!plan) return;
          setCleaning(true);
          request<CleanupResult>('library/storage/cleanup', { token: plan.token })
            .then(value => {
              setResult(value); setPlan(undefined);
              setNotice(t('已回收 %1', 'Reclaimed %1').replace('%1', kb(value.freedBytes)));
            })
            .catch(cause => setError(errorText(cause)))
            .finally(() => setCleaning(false));
        }}>
        {cleaning ? <Loader2 size={15} className="nw-spin" /> : <Trash2 size={15} />}
        {plan && plan.reclaimableBytes > 0 ? t('清理 %1', 'Clean up %1').replace('%1', kb(plan.reclaimableBytes)) : t('没有可清理的内容', 'Nothing to clean up')}
      </button>
    </div>
    {result && <p className="nw-help" role="status">{t('已回收 %1，移除 %2 个旧版本和 %3 个回收站项目。', 'Reclaimed %1, removed %2 history versions and %3 trash items.').replace('%1', kb(result.freedBytes)).replace('%2', String(result.removedVersions)).replace('%3', String(result.removedTrashItems))}</p>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
