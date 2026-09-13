'use client';
// C05: user-initiated local runtime diagnostics. The report is generated on
// demand by the desktop host (or the loopback dev gateway), redacted by the
// host, capped in size, and never uploaded anywhere: the only exports are
// clipboard and a local file the user explicitly picks.
import { useState } from 'react';
import { ClipboardCopy, FileDown, Stethoscope } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './runtime-diagnostics.css';

type DiagnosticsResult = { text: string; truncated: boolean; sizeBytes: number };

export function RuntimeDiagnosticsPanel() {
  const { request, t } = useWorkbench();
  const [report, setReport] = useState<DiagnosticsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const collect = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<DiagnosticsResult>('runtimeDiagnostics/collect', {});
      setReport(result);
      setNotice(t(`报告已在本地生成（${Math.round(result.sizeBytes / 1024)} KB），未发送到任何服务。`, `Report generated locally (${Math.round(result.sizeBytes / 1024)} KB). Nothing was sent anywhere.`));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(report.text); setNotice(t('报告已复制到剪贴板。', 'Report copied to the clipboard.')); }
    catch (e) { setError(errorText(e)); }
  };

  const save = async () => {
    if (!report) return;
    try {
      const result = await request<{ saved: boolean; reason?: string }>('runtimeDiagnostics/save', { text: report.text });
      if (result.saved) setNotice(t('报告已保存到本地文件。', 'Report saved to a local file.'));
      else setNotice(t('已取消保存。', 'Save canceled.'));
    } catch {
      // Desktop save dialog is unavailable (browser path): fall back to a
      // plain local download, still without any network destination.
      try {
        const blob = new Blob([report.text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `knorvia-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setNotice(t('报告已下载到浏览器默认下载位置。', 'Report downloaded to the browser download folder.'));
      } catch (e2) { setError(errorText(e2)); }
    }
  };

  return <section className="nw-diagnostics" aria-label={t('运行诊断', 'Runtime diagnostics')}>
    <header>
      <strong><Stethoscope size={15} /> {t('运行诊断', 'Runtime diagnostics')}</strong>
      <button className="nw-button" disabled={busy} onClick={() => void collect()}>
        {busy ? t('正在生成…', 'Generating…') : t('生成诊断报告', 'Generate diagnostics report')}
      </button>
    </header>
    <p className="nw-help">{t('在本地生成包含版本、组件健康、能力/端口状态与近期错误的报告；敏感值、完整路径与环境变量默认脱敏，不会上传。', 'Generates a local report with versions, component health, capability/port status and recent errors. Secrets, full paths and the environment are redacted by default; nothing is uploaded.')}</p>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    {notice && <p role="status" className="nw-help">{notice}</p>}
    {report && <div className="nw-diagnostics-report">
      <pre>{report.text}</pre>
      <div className="nw-diagnostics-actions">
        <button className="nw-button" onClick={() => void copy()}><ClipboardCopy size={14} />{t('复制报告', 'Copy report')}</button>
        <button className="nw-button" onClick={() => void save()}><FileDown size={14} />{t('保存到本地文件', 'Save to a local file')}</button>
        {report.truncated && <span className="nw-help">{t('报告超过大小上限，已裁剪。', 'The report exceeded the size cap and was trimmed.')}</span>}
      </div>
    </div>}
  </section>;
}
