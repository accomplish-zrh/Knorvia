"use client";

import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { fileSize } from '@/lib/native-project-context';
import type { ImportItem, ImportItemStatus } from '@/lib/library-import-queue';
import { useWorkbench } from './NativeWorkbenchProvider';

/**
 * P05: visible import-queue panel. Per-item status, per-item/batch cancel,
 * finite retry, and the explicit same-name conflict choice (keep both vs.
 * overwrite as a new version). Stalled items — restored after the page was
 * left, so the browser no longer holds the source files — demand
 * re-selection instead of pretending an upload can resume.
 */
export function LibraryImportQueuePanel({ items, visible, onCancelItem, onCancelBatch, onRetryItem, onRetryFailed, onKeepBoth, onOverwrite, onRequeueFiles, onDismiss }: {
  items: ImportItem[];
  visible: boolean;
  onCancelItem: (key: string) => void;
  onCancelBatch: () => void;
  onRetryItem: (key: string) => void;
  onRetryFailed: () => void;
  onKeepBoth: (item: ImportItem) => void;
  onOverwrite: (item: ImportItem) => void;
  onRequeueFiles: (files: File[]) => void;
  onDismiss: () => void;
}) {
  const { t } = useWorkbench();
  const reselectRef = useRef<HTMLInputElement>(null);
  const [reselectError, setReselectError] = useState('');
  if (!visible || !items.length) return null;
  const done = items.filter(item => item.status === 'done').length;
  const failed = items.filter(item => item.status === 'failed' || item.status === 'conflict').length;
  const stalled = items.filter(item => item.status === 'stalled');
  const active = items.some(item => item.status === 'uploading' || item.status === 'queued');
  const statusView = (item: ImportItem) => {
    switch (item.status) {
      case 'uploading': return <span className="nl-import-state is-active"><Loader2 className="nw-spin" size={13} />{item.progress}%</span>;
      case 'queued': return <span className="nl-import-state">{t('等待中', 'Queued')}</span>;
      case 'done': return <span className="nl-import-state is-done"><CheckCircle2 size={13} />{t('已导入', 'Imported')}</span>;
      case 'canceled': return <span className="nl-import-state is-muted">{t('已取消', 'Canceled')}</span>;
      case 'stalled': return <span className="nl-import-state is-muted">{t('待重新选择文件', 'Needs re-selection')}</span>;
      case 'conflict': return <span className="nl-import-state is-failed"><AlertCircle size={13} />{t('同名冲突', 'Name conflict')}</span>;
      default: return <span className="nl-import-state is-failed"><XCircle size={13} />{t('失败', 'Failed')}</span>;
    }
  };
  return <div className="nl-import-panel" role="region" aria-label={t('批量导入进度', 'Import progress')}>
    <div className="nl-import-head">
      <strong>{t('导入资料', 'Importing files')}</strong>
      <span className="nl-import-summary">{done}/{items.length}{failed ? ` · ${failed} ${t('项失败', 'failed')}` : ''}</span>
      <div className="nl-import-head-actions">
        {stalled.length > 0 && <button className="nw-button nw-button-small" onClick={() => reselectRef.current?.click()}>{t('重新选择文件', 'Re-select files')}</button>}
        {failed > 0 && <button className="nw-button nw-button-small" onClick={onRetryFailed}>{t('重试失败项', 'Retry failed')}</button>}
        {active
          ? <button className="nw-button nw-button-small" onClick={onCancelBatch}>{t('全部取消', 'Cancel all')}</button>
          : <button className="nw-icon" aria-label={t('关闭导入列表', 'Dismiss import list')} onClick={onDismiss}><X size={15} /></button>}
      </div>
    </div>
    {stalled.length > 0 && <p className="nl-import-note">{t('浏览器离开页面后不再持有这些文件；重新选择同名文件后才会继续上传。', 'The browser dropped these files when you left the page; re-select files with the same names to continue.')}</p>}
    {reselectError && <p className="nl-import-note is-failed" role="alert">{reselectError}</p>}
    <input ref={reselectRef} type="file" multiple hidden onChange={event => {
      const picked = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (!picked.length) return;
      const byName = new Map(stalled.map(item => [item.name, item] as const));
      const unmatched = picked.filter(file => !byName.has(file.name));
      if (unmatched.length === picked.length) { setReselectError(t('没有匹配待重传的文件名。', 'None of the chosen names match the pending items.')); return; }
      if (unmatched.length) setReselectError(t('部分文件不匹配，已跳过：', 'Some files did not match and were skipped: ') + unmatched.map(file => file.name).join(', '));
      else setReselectError('');
      onRequeueFiles(picked);
    }} />
    <ul className="nl-import-list">
      {items.map(item => <li key={item.key} data-status={item.status}>
        <span className="nl-import-name" title={item.path}>{item.name}</span>
        <small>{fileSize(item.size)}</small>
        {statusView(item)}
        {item.error && item.status !== 'conflict' && <span className="nl-import-error" title={item.error}>{item.error}</span>}
        {item.status === 'conflict' && <span className="nl-import-actions">
          <button className="nw-button nw-button-small" onClick={() => onKeepBoth(item)}>{t('保留两份', 'Keep both')}</button>
          <button className="nw-button nw-button-small" onClick={() => onOverwrite(item)}>{t('覆盖为新版本', 'Overwrite as version')}</button>
        </span>}
        {(item.status === 'queued' || item.status === 'uploading') && <button className="nw-icon" aria-label={`${t('取消', 'Cancel')}: ${item.name}`} onClick={() => onCancelItem(item.key)}><X size={13} /></button>}
        {item.status === 'failed' && <button className="nw-button nw-button-small" onClick={() => onRetryItem(item.key)}>{t('重试', 'Retry')}</button>}
      </li>)}
    </ul>
  </div>;
}
