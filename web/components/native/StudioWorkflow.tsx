"use client";
import { useEffect, useRef, useState } from 'react';
import { FileJson, Upload } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
type Field = { node: string; input: string; title: string; type: string; value: unknown };
type Report = { workflow: Record<string, unknown>; sha256: string; fields: Field[]; nodes: { id: string; type: string; title: string }[] };
type Binding = { node: string; input: string };
export function StudioWorkflow({ custom, kind, change }: { custom: string; kind: 'image' | 'video'; change: (value: string) => void }) {
  const { request, t } = useWorkbench();
  const file = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<Report>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  let config: { workflow?: Record<string, unknown>; bindings?: Record<string, Binding>; outputNode?: string } = {};
  try { config = JSON.parse(custom); } catch { /* Advanced JSON can be partially edited. */ }
  const graphKey = JSON.stringify(config?.workflow);
  useEffect(() => {
    let live = true;
    if (!graphKey) { setReport(undefined); return; }
    void request<Report>('studio/workflow/inspect', { workflow: JSON.parse(graphKey) }).then(r => { if (live) { setReport(r); setError(''); } }).catch(e => { if (live) { setReport(undefined); setError(errorText(e)); } });
    return () => { live = false; };
  }, [graphKey, request]);
  const roles = [['prompt', t('提示词', 'Prompt')], ['seconds', t('时长（秒）', 'Duration (seconds)')], ['count', t('生成数量', 'Count')], ['size', t('尺寸', 'Size')], ['aspect', t('画幅', 'Aspect ratio')], ...(kind === 'video' ? [['firstFrame', t('首帧', 'First frame')], ['lastFrame', t('尾帧', 'Last frame')]] : [['reference', t('参考图', 'Reference')]])];
  return <div className="ns-workflow">
    <div className="ns-workflow-heading"><FileJson size={17} /><strong>{t('ComfyUI 工作流', 'ComfyUI workflow')}</strong><button type="button" className="nw-button" disabled={busy} onClick={() => file.current?.click()}><Upload size={15} />{t('导入 JSON', 'Import JSON')}</button></div>
    <input ref={file} type="file" accept=".json,application/json" hidden onChange={async e => {
      const selected = e.target.files?.[0]; e.target.value = ''; if (!selected) return;
      setBusy(true); setError('');
      try {
        if (selected.size > 512 * 1024) throw new Error(t('工作流最大支持 512 KB', 'Workflow limit is 512 KB'));
        const r = await request<Report>('studio/workflow/inspect', { workflow: await selected.text() });
        setReport(r); change(JSON.stringify({ ...config, workflow: r.workflow, bindings: {}, outputNode: undefined }, null, 2));
      } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
    }} />
    <p className="ns-hint">{t('从 ComfyUI 导出 API 格式后导入，再选择对应字段。秒数不能绑定到帧数；节点之间的连接会保留。', 'Import the API format exported by ComfyUI, then map fields. Do not map seconds to frame counts. Node connections are preserved.')}</p>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {report && <><p className="ns-hint">{report.nodes.length}{t(' 个节点', ' nodes')} · {report.sha256.slice(0, 12)}</p><div className="ns-form-grid">{roles.map(([role, label]) => {
      const selected = config.bindings?.[role];
      const fields = report.fields.filter(f => f.type === (['seconds', 'count'].includes(role) ? 'number' : 'string'));
      return <label key={role}>{label}<select required={role === 'prompt'} aria-label={label} value={selected ? JSON.stringify([selected.node, selected.input]) : ''} onChange={e => { const bindings = { ...config.bindings }; if (e.target.value) { const [node, input] = JSON.parse(e.target.value); bindings[role] = { node, input }; } else delete bindings[role]; change(JSON.stringify({ ...config, bindings }, null, 2)); }}><option value="">{role === 'prompt' ? t('选择提示词字段', 'Choose prompt field') : t('保留工作流原值', 'Keep workflow value')}</option>{fields.map(f => <option key={JSON.stringify([f.node, f.input])} value={JSON.stringify([f.node, f.input])}>{f.title} · {f.node} / {f.input}</option>)}</select></label>;
    })}<label>{t('输出节点', 'Output node')}<select aria-label={t('输出节点', 'Output node')} value={config.outputNode ?? ''} onChange={e => change(JSON.stringify({ ...config, outputNode: e.target.value || undefined }, null, 2))}><option value="">{t('所有媒体输出', 'All media outputs')}</option>{report.nodes.map(n => <option key={n.id} value={n.id}>{n.title} · {n.id}</option>)}</select></label></div></>}
  </div>;
}
