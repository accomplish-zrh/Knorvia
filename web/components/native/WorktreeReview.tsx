'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle, Download, FileDiff, Loader2, ShieldCheck } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import {
  buildReviewReport,
  deliveryVerdict,
  parseCompare,
  requestDiffParams,
  type WorktreeCompare,
} from '@/lib/native-worktree-review';
import './worktree-review.css';

const VERDICT = {
  fastForward: { zh: '目标落后于源：可以直接快进合并（本工具不会替你合并）', en: 'Target is behind: a fast-forward would apply (this tool never merges for you)' },
  diverged: { zh: '双方各有提交：需要先自行合并或变基（本工具不会替你合并）', en: 'Both sides moved: merge or rebase yourself first (this tool never merges for you)' },
  upToDate: { zh: '目标没有领先于源的提交', en: 'The target has no commits beyond the source' },
} as const;

/**
 * Delivery pre-check (B05): freeze HEAD and the chosen ref, review commits,
 * files, uncommitted work and the conflict prediction, then inspect one file
 * diff at a time. Strictly read-only and exportable as a report.
 */
export function WorktreeReview({ workspaceId, close }: { workspaceId: string; close: () => void }) {
  const { request, t } = useWorkbench();
  const [targetRef, setTargetRef] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compare, setCompare] = useState<WorktreeCompare | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [diffPath, setDiffPath] = useState('');
  const [diffText, setDiffText] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const run = useCallback(async () => {
    if (!targetRef.trim()) return;
    setComparing(true);
    setError('');
    setCompare(null);
    setUnavailable(false);
    setDiffPath('');
    setDiffText('');
    try {
      const value = await request<unknown>('workspace/git/compare', { workspaceId, targetRef: targetRef.trim() });
      const parsed = parseCompare(workspaceId, value);
      if (!parsed.available) { setUnavailable(true); return; }
      setCompare(parsed);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setComparing(false);
    }
  }, [workspaceId, targetRef, request]);

  const openDiff = useCallback(async (path: string) => {
    if (!compare) return;
    setLoadingDiff(true);
    setError('');
    try {
      const params = requestDiffParams(compare, path);
      const value = await request<{ diff: string; truncated: boolean }>('workspace/git/compare-diff', { workspaceId, ...params });
      setDiffPath(path);
      setDiffText(value.truncated ? `${value.diff}\n… (truncated)` : value.diff);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoadingDiff(false);
    }
  }, [compare, workspaceId, request]);

  const exportReport = useCallback(async () => {
    if (!compare) return;
    setExporting(true);
    try {
      const diffs: { path: string; diff: string }[] = [];
      const wanted = compare.incomingFiles.slice(0, 20);
      for (const file of wanted) {
        try {
          const params = requestDiffParams(compare, file.path);
          const value = await request<{ diff: string; truncated: boolean }>('workspace/git/compare-diff', { workspaceId, ...params });
          diffs.push({ path: file.path, diff: value.truncated ? `${value.diff}\n… (truncated)` : value.diff });
        } catch { /* a single unavailable diff does not sink the report */ }
      }
      const body = buildReviewReport(compare, diffs);
      const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `knorvia-delivery-review-${compare.targetSha.slice(0, 10)}.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setExporting(false);
    }
  }, [compare, workspaceId, request]);

  const verdict = compare ? deliveryVerdict(compare) : null;
  const busy = comparing || loadingDiff || exporting;
  return <Modal title={t('交付预检', 'Delivery review')} close={close} busy={busy}>
    <div className="ht-review" aria-busy={busy}>
      <p className="nw-help">{t('冻结源与目标的版本后逐项核对：提交、文件、未提交改动与冲突预判。全程只读，不会合并。', 'Freezes both sides, then reviews commits, files, uncommitted work and the conflict prediction. Strictly read-only; it never merges.')}</p>
      <form className="ht-review-form" onSubmit={event => { event.preventDefault(); void run(); }}>
        <input aria-label={t('目标 ref', 'Target ref')} placeholder={t('目标 ref（分支、标签或 SHA）', 'Target ref (branch, tag or SHA)')} value={targetRef} maxLength={256} onChange={event => setTargetRef(event.target.value)} />
        <button type="submit" className="nw-button nw-button-primary" disabled={busy || !targetRef.trim()}>
          {comparing ? <Loader2 size={14} className="nw-spin" /> : <ShieldCheck size={14} />}{t('解析并冻结', 'Resolve and freeze')}
        </button>
      </form>
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      {unavailable && <p className="nw-help" role="status">{t('这个项目尚未使用 Git。', 'This project does not use Git yet.')}</p>}
      {compare && verdict && <div className="ht-review-body">
        <p className={`ht-review-verdict${verdict.conflictGate ? ' is-blocked' : ''}`} role="status">
          {verdict.conflictGate ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
          {t(VERDICT[verdict.kind].zh, VERDICT[verdict.kind].en)}
        </p>
        <dl className="ht-review-facts">
          <dt>{t('源', 'Source')}</dt><dd><code>{compare.sourceRef}</code> → <code>{compare.sourceSha.slice(0, 12)}</code></dd>
          <dt>{t('目标', 'Target')}</dt><dd><code>{compare.targetRef}</code> → <code>{compare.targetSha.slice(0, 12)}</code></dd>
          <dt>{t('合并基', 'Merge base')}</dt><dd>{compare.mergeBaseSha ? <code>{compare.mergeBaseSha.slice(0, 12)}</code> : t('无共同祖先', 'unrelated histories')}</dd>
          <dt>{t('领先 / 落后', 'Ahead / Behind')}</dt><dd>+{compare.ahead} / −{compare.behind}</dd>
          <dt>{t('冲突预判', 'Conflict prediction')}</dt>
          <dd>
            <span className={`ht-review-conflict is-${compare.conflicts.state}`}>
              {compare.conflicts.state === 'clean' ? t('无冲突', 'Clean')
                : compare.conflicts.state === 'conflict' ? t(`冲突 ×${compare.conflicts.files.length}`, `Conflicts ×${compare.conflicts.files.length}`)
                  : t('未能判定', 'Undetermined')}
            </span>
            {compare.conflicts.state === 'conflict' && <ul className="ht-review-conflict-files">{compare.conflicts.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
            {compare.conflicts.state === 'undetermined' && <span className="nw-help">{compare.conflicts.reason ?? t('当前 Git 无法预判。', 'Current Git cannot predict this.')}</span>}
          </dd>
          <dt>{t('未提交改动', 'Uncommitted')}</dt>
          <dd>{compare.dirty.staged.length + compare.dirty.unstaged.length + compare.dirty.untracked.length === 0
            ? t('工作区干净', 'Clean tree')
            : t(`${compare.dirty.staged.length} 暂存 · ${compare.dirty.unstaged.length} 未暂存 · ${compare.dirty.untracked.length} 未跟踪`, `${compare.dirty.staged.length} staged · ${compare.dirty.unstaged.length} unstaged · ${compare.dirty.untracked.length} untracked`)}{compare.dirty.truncated ? t('（有截断）', ' (truncated)') : ''}</dd>
        </dl>
        <details open><summary>{t(`收入提交（${compare.incomingCommits.length}）`, `Incoming commits (${compare.incomingCommits.length})`)}</summary>
          <ul className="ht-review-commits">{compare.incomingCommits.map(commit => <li key={commit.id}><code>{commit.short}</code> {commit.subject}</li>)}
            {compare.incomingCommits.length === 0 && <li>{t('（无）', '(none)')}</li>}</ul>
        </details>
        <details><summary>{t(`源侧独有提交（${compare.outgoingCommits.length}）`, `Source-only commits (${compare.outgoingCommits.length})`)}</summary>
          <ul className="ht-review-commits">{compare.outgoingCommits.map(commit => <li key={commit.id}><code>{commit.short}</code> {commit.subject}</li>)}
            {compare.outgoingCommits.length === 0 && <li>{t('（无）', '(none)')}</li>}</ul>
        </details>
        <details open><summary>{t(`涉及文件（${compare.incomingFiles.length}）`, `Files (${compare.incomingFiles.length})`)}</summary>
          <ul className="ht-review-files">{compare.incomingFiles.map(file => <li key={file.path}>
            <button type="button" className={diffPath === file.path ? 'is-active' : ''} onClick={() => void openDiff(file.path)}>
              <FileDiff size={13} /><span className="ht-review-file-status">{file.status}</span>{file.path}
            </button>
          </li>)}
            {compare.incomingFiles.length === 0 && <li>{t('（无）', '(none)')}</li>}</ul>
        </details>
        {loadingDiff && <p className="nw-help" role="status"><Loader2 size={13} className="nw-spin" /> {t('正在读取文件差异…', 'Reading the file diff…')}</p>}
        {diffText && <pre className="ht-review-diff" aria-label={t('文件差异', 'File diff')}>{diffText}</pre>}
        <div className="ht-review-actions">
          <button type="button" className="nw-button" disabled={busy} onClick={() => void exportReport()}>
            <Download size={14} />{t('导出预检报告 (Markdown)', 'Export review report (Markdown)')}
          </button>
        </div>
      </div>}
    </div>
  </Modal>;
}
