"use client";

import { memo } from 'react';
import { Check, Film, Image as ImageIcon, Loader2, Square } from 'lucide-react';
import { studioFinished, type StudioJob } from '@/lib/native-studio';
import { displayTime } from '@/lib/native-workbench-state';
import { StudioMedia } from './StudioMedia';

type Translate = (zh: string, en: string) => string;
export function studioStageLabel(job: StudioJob, t: Translate) {
  return ({ queued: t('排队中', 'Queued'), submitting: t('正在提交', 'Submitting'), generating: t('正在生成', 'Generating'), downloading: t('保存作品', 'Saving media'), publishing: t('整理作品', 'Finishing'), completed: t('已完成', 'Completed'), failed: t('生成失败', 'Failed'), unknown: t('提交结果未知', 'Submission outcome unknown'), paused: t('等待继续', 'Ready to resume'), 'needs-connection': t('需要恢复连接', 'Connection needed'), stopped: t('已停止', 'Stopped') }[job.phase] ?? job.status);
}

// Draft keystrokes do not redraw the gallery. Cards keep their media elements
// and scroll position when the creation form changes.
export const StudioGallery = memo(function StudioGallery({ jobs, busy, locale, t, open, action, continueFrom }: {
  jobs: StudioJob[]; busy: boolean; locale: 'zh' | 'en'; t: Translate;
  open: (job: StudioJob) => void;
  action: (job: StudioJob, method: string) => Promise<void>;
  continueFrom: (job: StudioJob) => void;
}) {
  return <div className="ns-gallery">{jobs.map(job => <article key={job.id} className="ns-job" data-job-id={job.id} data-phase={job.phase}>
    <button className="ns-job-open" onClick={() => open(job)}>
      {job.outputs?.length ? <StudioMedia job={job} thumbnail /> : <div className={`ns-job-placeholder ${job.kind}`}>
        {studioFinished(job) ? job.kind === 'video' ? <Film size={28} /> : <ImageIcon size={28} /> : <Loader2 size={23} className={['paused', 'needs-connection'].includes(job.phase) ? '' : 'nw-spin'} />}
        <span>{studioStageLabel(job, t)}</span>
      </div>}
      <div className="ns-job-copy"><p>{job.input?.prompt || t('未完成的创作请求', 'Incomplete creation request')}</p><span><span className="ns-job-provider" title={job.provider?.name}>{job.provider?.name ?? t('未指定模型', 'No model')}</span><i aria-hidden="true">·</i><time>{displayTime(job.createdAt, locale === 'zh' ? 'zh-CN' : 'en-US')}</time></span></div>
    </button>
    <footer><span data-status={job.status}>{job.status === 'succeeded' && <Check size={12} />}{studioStageLabel(job, t)}{!studioFinished(job) && job.progress ? ` ${Math.round(job.progress)}%` : ''}</span>
      {!studioFinished(job) && !['paused', 'needs-connection'].includes(job.phase)
        ? <button className="nw-icon" disabled={busy} aria-label={t('停止生成', 'Stop generation')} onClick={() => void action(job, 'studio/cancel')}><Square size={12} /></button>
        : <button onClick={() => continueFrom(job)}>{t('继续创作', 'Create again')}</button>}
    </footer>
  </article>)}</div>;
});
