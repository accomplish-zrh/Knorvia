"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookMarked, Download, Loader2, Pencil, Search, Trash2, Upload, X } from 'lucide-react';
import type { StudioTemplate } from '@/lib/native-studio';
import { errorText } from './NativeWorkbenchProvider';

type Translater = (zh: string, en: string) => string;
type EditingTemplate = Pick<StudioTemplate, 'id' | 'revision' | 'name' | 'kind' | 'prompt' | 'defaults'>;
const variablesIn = (value: string) => [...new Set([...value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map(match => match[1]))];

// Personal prompt templates on the composer toolbar: save the current prompt,
// apply a template, import/export. A light menu — never a homepage card wall.
export function StudioTemplateMenu({ request, t, kind, prompt, onApply, onNotice }: {
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  t: Translater;
  kind: 'image' | 'video';
  prompt: string;
  onApply: (text: string) => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<EditingTemplate>();
  const [applying, setApplying] = useState<StudioTemplate>();
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null), importInput = useRef<HTMLInputElement>(null);
  const dialogId = useId(), requestVersion = useRef(0);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 500, transform: 'none' });
  const close = () => { if (busy) return; setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const refresh = async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const result = await request<{ templates: StudioTemplate[]; warning?: string }>('studio/template/list', { query });
      if (version !== requestVersion.current) return;
      setTemplates(result.templates);
      if (result.warning) setError(result.warning);
    } finally { if (version === requestVersion.current) setLoading(false); }
  };
  useEffect(() => { if (open) void refresh().catch(e => setError(errorText(e))); }, [open, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      if (!busy && (anchor.bottom < 8 || anchor.top > window.innerHeight - 8)) { setOpen(false); return; }
      const width = Math.min(380, window.innerWidth - 24);
      const height = Math.min(580, window.innerHeight - 24);
      const below = window.innerHeight - anchor.bottom - 20;
      const above = anchor.top - 20;
      const useBelow = below >= Math.min(320, height) || below >= above;
      const maxHeight = Math.max(120, Math.min(height, useBelow ? below : above));
      setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)), top: useBelow ? anchor.bottom + 8 : anchor.top - 8, maxHeight, transform: useBelow ? 'none' : 'translateY(-100%)' });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, busy]);
  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector<HTMLInputElement>('.ns-template-search input')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open || busy) return;
    const dismiss = (event: MouseEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('focusin', dismiss); };
  }, [open, busy]);
  const apply = async (template: StudioTemplate, params = template.defaults) => {
    setBusy(true); setError('');
    try {
      const rendered = await request<{ text: string }>('studio/template/render', { id: template.id, revision: template.revision, params });
      onApply(rendered.text);
      setOpen(false); setApplying(undefined);
      trigger.current?.focus({ preventScroll: true });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const choose = (template: StudioTemplate) => {
    setError(''); setEditing(undefined);
    if (template.variables.length) { setApplying(template); setVariables({ ...template.defaults }); }
    else void apply(template);
  };
  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      await request('studio/template/save', { ...editing, expectedRevision: editing.revision });
      await refresh(); setEditing(undefined);
      onNotice(t('模板已更新，已保存分镜保持原内容', 'Template updated. Saved shots keep their original content.'));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const saveCurrent = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setError('');
    try {
      await request('studio/template/save', { name: prompt.trim().slice(0, 40), kind: 'any', prompt: prompt.trim() });
      onNotice(t('已保存为个人模板', 'Saved as a personal template'));
      await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (template: StudioTemplate) => {
    setBusy(true); setError('');
    try { await request('studio/template/remove', { id: template.id, expectedRevision: template.revision }); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const exportAll = async () => {
    setBusy(true); setError('');
    try {
      const result = await request<{ templates: StudioTemplate[] }>('studio/template/list', {});
      const payload = { version: 1, exportedAt: new Date().toISOString(), templates: result.templates.map(({ name, kind, prompt, defaults }) => ({ name, kind, prompt, defaults })) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'knorvia-templates.json';
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    setBusy(true); setError('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(t('模板文件不能超过 5 MB', 'Template files must be under 5 MB'));
      const parsed = JSON.parse(await file.text());
      if (parsed?.version !== undefined && parsed.version !== 1) throw new Error(t('此模板文件版本不受支持', 'This template file version is not supported'));
      const result = await request<{ imported: number }>('studio/template/import', { templates: parsed.templates ?? parsed });
      onNotice(t(`已导入 ${result.imported} 个模板`, `Imported ${result.imported} templates`));
      await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const visibleTemplates = templates.filter(template => template.kind === 'any' || template.kind === kind);
  const portalRoot = trigger.current?.closest('.nw-root');
  return <div className="ns-template-menu">
    <button ref={trigger} type="button" className="nw-button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} disabled={busy} onClick={() => setOpen(current => !current)}><BookMarked size={15} />{t('模板', 'Templates')}</button>
    {open && portalRoot && createPortal(<div ref={popover} id={dialogId} className="ns-template-popover" style={position} role="dialog" aria-label={t('个人提示词模板', 'Personal prompt templates')} aria-busy={busy} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header className="ns-template-heading"><strong>{t('提示词模板', 'Prompt templates')}</strong><button className="nw-icon" type="button" aria-label={t('关闭模板', 'Close templates')} disabled={busy} onClick={close}><X size={16} /></button></header>
      <div className="ns-template-search"><Search size={16} /><input aria-label={t('搜索模板', 'Search templates')} value={query} disabled={busy} onChange={e => setQuery(e.target.value)} placeholder={t('搜索模板', 'Search templates')} /></div>
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      {editing ? <form className="ns-template-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void saveEdit(); }}>
        <label>{t('模板名称', 'Template name')}<input autoFocus required disabled={busy} maxLength={100} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
        <label>{t('提示词', 'Prompt')}<textarea required disabled={busy} maxLength={12000} rows={5} value={editing.prompt} onChange={event => setEditing({ ...editing, prompt: event.target.value })} /></label>
        {variablesIn(editing.prompt).map(name => <label key={name}>{t('默认值', 'Default')} · {name}<input disabled={busy} value={String(editing.defaults[name] ?? '')} onChange={event => setEditing({ ...editing, defaults: { ...editing.defaults, [name]: event.target.value } })} /></label>)}
        <div className="ns-template-tools"><button className="nw-button" type="submit" disabled={busy}>{t('保存修改', 'Save changes')}</button><button className="nw-button" type="button" disabled={busy} onClick={() => setEditing(undefined)}>{t('返回', 'Back')}</button></div>
      </form> : applying ? <form className="ns-template-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void apply(applying, variables); }}>
        <strong>{applying.name}</strong><p className="ns-hint">{applying.prompt}</p>
        {applying.variables.map((name, index) => <label key={name}>{name}<input autoFocus={index === 0} required disabled={busy} value={String(variables[name] ?? '')} onChange={event => setVariables({ ...variables, [name]: event.target.value })} /></label>)}
        <div className="ns-template-tools"><button className="nw-button" type="submit" disabled={busy}>{t('应用模板', 'Apply template')}</button><button className="nw-button" type="button" disabled={busy} onClick={() => setApplying(undefined)}>{t('返回', 'Back')}</button></div>
      </form> : <>
      <ul className="ns-template-list">
        {loading ? <li className="ns-template-empty" role="status"><Loader2 size={17} className="nw-spin" />{t('正在读取模板…', 'Loading templates…')}</li> : !visibleTemplates.length && <li className="ns-template-empty">{query ? t('没有匹配的模板，试试其他关键词。', 'No matching templates. Try another search.') : t('还没有适用的模板。写下提示词后可以保存在这里。', 'No templates for this format yet. Write a prompt and save it here.')}</li>}
        {!loading && visibleTemplates.map(template => <li key={template.id} className="ns-template-item">
          <button type="button" className="ns-template-apply" disabled={busy} title={template.prompt} onClick={() => choose(template)}>
            <strong>{template.name}</strong>
            <span>{template.prompt.slice(0, 60)}{template.prompt.length > 60 ? '…' : ''}</span>
            {template.variables.length > 0 && <em>{`{{ ${template.variables.join(', ')} }}`}</em>}
          </button>
          <button type="button" className="nw-icon" aria-label={`${t('编辑模板', 'Edit template')}: ${template.name}`} disabled={busy} onClick={() => { setEditing({ ...template, defaults: { ...template.defaults } }); setError(''); }}><Pencil size={14} /></button>
          <button type="button" className="nw-icon" aria-label={`${t('删除模板', 'Delete template')}: ${template.name}`} disabled={busy} onClick={() => void remove(template)}><Trash2 size={14} /></button>
        </li>)}
      </ul>
      <div className="ns-template-tools">
        <button type="button" className="nw-button" disabled={busy || !prompt.trim()} onClick={() => void saveCurrent()}>{t('保存当前提示词', 'Save current prompt')}</button>
        <button type="button" className="nw-icon" aria-label={t('导出模板', 'Export templates')} disabled={busy} onClick={() => void exportAll()}><Download size={15} /></button>
        <button type="button" className="nw-icon ns-template-import" aria-label={t('导入模板', 'Import templates')} disabled={busy} onClick={() => importInput.current?.click()}><Upload size={15} /></button>
        <input ref={importInput} type="file" accept="application/json" disabled={busy} hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }} />
      </div>
      <p className="ns-hint">{t('变量写法：{{subject}}。可以设置默认值，也可以应用时填写。', 'Variables: {{subject}}. Set defaults or fill them in when applying.')}</p>
      </>}
    </div>, portalRoot)}
  </div>;
}
