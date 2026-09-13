"use client";
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

// C14: local package integrity check. Verifies core components and the web
// build against the manifest generated from the actual build inputs. The
// claim is content consistency only — no signing keys, no publisher
// authentication. Old packages without a manifest are reported as unknown
// instead of trusted.
type ComponentState = { name: string; status: 'ok' | 'missing' | 'modified' };
type IntegrityReport = {
  status: 'ok' | 'compromised' | 'unknown';
  source: { sourceSha: string; sourceDirty: number | null; verified: boolean };
  core: { status: string; detail: string; missing: string[]; mismatched: string[]; components: ComponentState[] };
  web: { status: string; missing: string[]; mismatched: string[]; files: number };
  claim: string;
  note: string;
};

const label = (value: string) => ({
  ok: '一致', compromised: '异常', unknown: '未验证', missing: '缺失', modified: '内容不同',
}[value] || value);

export function RuntimeIntegritySettings() {
  const { request, connection, t } = useWorkbench();
  const [report, setReport] = useState<IntegrityReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    setBusy(true); setError('');
    try { setReport(await request<IntegrityReport>('runtimeIntegrity/check', {})); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }, [request]);
  useEffect(() => { if (connection === 'connected') void check(); }, [check, connection]);
  return <section className="nw-preference-section nw-runtime-integrity"><h2>{t('组件完整性', 'Runtime integrity')}</h2>
    <p className="nw-help">{t('对照打包时生成的组件清单，核对引擎、内核与页面构建是否被替换或缺失。检查只在本机离线进行，不读取对话内容。清单只声明内容一致，不代表发行者签名。', 'Verifies the engine, kernel and web build against the manifest generated at packaging time. The check is offline and never reads conversations. It claims content consistency only — not a publisher signature.')}</p>
    <div className="nw-preference-actions">
      <button className="nw-button" disabled={busy || connection !== 'connected'} onClick={() => void check()}>
        {busy ? <Loader2 size={14} className="nw-spin" /> : <RefreshCw size={14} />}{t('重新检查', 'Recheck')}
      </button>
    </div>
    {report && <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('检查结果', 'Result')}</strong>
        <p>{report.status === 'ok' ? t('所有组件与构建清单一致。', 'All components match the build manifest.') : report.status === 'unknown' ? t('此安装包没有完整性清单（旧包），按兼容策略运行，标记为未验证。', 'This package has no integrity manifest (old package). It runs under the compatibility policy and stays marked unverified.') : t('发现与构建清单不一致的组件。', 'Components differ from the build manifest.')}</p></div>
        <div className="nw-preference-control"><span className="nw-muted-label">{label(report.status)}</span></div>
      </div>
      <div className="nw-preference-row"><div><strong>{t('构建来源', 'Build source')}</strong>
        <p>{report.source.verified ? `${report.source.sourceSha.slice(0, 12)}${report.source.sourceDirty ? ` · ${t('有未提交改动', 'with uncommitted changes')}` : ''}` : t('未知（无清单）', 'unknown (no manifest)')}</p></div>
      </div>
      {report.core.missing.length > 0 && <div className="nw-preference-row"><div><strong>{t('缺失组件', 'Missing components')}</strong><p>{report.core.missing.join(', ')}</p></div></div>}
      {report.core.mismatched.length > 0 && <div className="nw-preference-row"><div><strong>{t('内容不同的组件', 'Modified components')}</strong><p>{report.core.mismatched.join(', ')}</p></div></div>}
      {report.web.missing.length > 0 && <div className="nw-preference-row"><div><strong>{t('缺失的页面文件', 'Missing web files')}</strong><p>{report.web.missing.slice(0, 8).join(', ')}{report.web.missing.length > 8 ? ` (+${report.web.missing.length - 8})` : ''}</p></div></div>}
      {report.web.mismatched.length > 0 && <div className="nw-preference-row"><div><strong>{t('内容不同的页面文件', 'Modified web files')}</strong><p>{report.web.mismatched.slice(0, 8).join(', ')}{report.web.mismatched.length > 8 ? ` (+${report.web.mismatched.length - 8})` : ''}</p></div></div>}
      {report.status === 'ok' && <div className="nw-preference-row"><div><strong>{t('页面构建', 'Web build')}</strong><p>{t('%1 个静态文件已核对。', '%1 static files verified.').replace('%1', String(report.web.files))}</p></div><div className="nw-preference-control"><ShieldCheck size={16} /></div></div>}
    </div>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
