'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, FolderOpen, Github, History, Loader2, Package, Plus, Power, Trash2, Wand2 } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import './extension-manager.css';

type Source = { type: 'local'; workspaceId: string; path: string } | { type: 'github'; repository: string; commit: string; subdirectory?: string };
type Report = { format: string; status: string; components: { component: string; format: string; status: string; details: string; name?: string }[] };
type Entry = { id: string; name: string; revision: number; enabled: boolean; activeVersion: string; report: Report; recoveryError?: string; versions: { id: string; createdAt: string; sha256: string; source: Partial<Source> }[] };
type Inspection = { sha256: string; files: number; bytes: number; report: Report };
type StoragePlan = { token: string; installed: { id: string; name: string; enabled: boolean; versions: number; bytes: number }[]; reclaimable: { kind: string; id: string; versionId?: string; bytes: number }[]; protectedModified: { id: string; versionId?: string; reason: string }[]; reclaimableBytes: number };
type StorageCleanup = { freedBytes: number; removedPackages: number; removedVersions: number };
type ConvertPlan = { extension: { packageSha256: string }; items: { command: string; skillName: string; status: string; description?: string; notes?: string[]; refusals?: string[] }[] };
type ExportResult = { id: string; name: string; status: string; detail?: string };

export function ExtensionManager({ workspaceId: requestedWorkspace }: { workspaceId?: string }) {
  const { request, t, workspaces, workspaceId, connection, connectionInfo } = useWorkbench();
  const canTransferExtensions = connection === 'connected' && connectionInfo?.transport === 'desktop';
  const [entries, setEntries] = useState<Entry[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryError, setRecoveryError] = useState('');
  const [importing, setImporting] = useState(false), [updating, setUpdating] = useState<Entry>(), [removing, setRemoving] = useState<Entry>();
  const [history, setHistory] = useState<Entry>(), [version, setVersion] = useState('');
  const [sourceType, setSourceType] = useState<'local' | 'github'>('local'), [project, setProject] = useState(requestedWorkspace || workspaceId);
  const [localPath, setLocalPath] = useState(''), [repository, setRepository] = useState(''), [commit, setCommit] = useState(''), [subdirectory, setSubdirectory] = useState('');
  const [inspection, setInspection] = useState<Inspection>();
  const [builtinSkills, setBuiltinSkills] = useState<{ name: string; userModified?: boolean; updateAvailable?: boolean }[]>([]);
  const localProjects = workspaces.filter(p => p.cwd);
  const load = useCallback(async () => {
    try {
      const result = await request<{ entries: Entry[]; recoveryError?: string }>('extension/list', {});
      setEntries(result.entries);
      setRecoveryError(result.recoveryError || '');
      const builtin = await request<{ skills: { name: string; userModified?: boolean; updateAvailable?: boolean }[] }>('extension/builtin/status', {}).catch(() => ({ skills: [] }));
      setBuiltinSkills(builtin?.skills || []);
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => { if (connection === 'connected') { setError(''); void load().catch(e => setError(errorText(e))); } }, [load, connection]);
  useEffect(() => { setInspection(undefined); }, [sourceType, project, localPath, repository, commit, subdirectory]);
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const source = (): Source => sourceType === 'local' ? { type: 'local', workspaceId: project, path: localPath.trim() } : { type: 'github', repository: repository.trim(), commit: commit.trim(), subdirectory: subdirectory.trim() };
  const startImport = (entry?: Entry) => {
    setUpdating(entry); setInspection(undefined); setError(''); setProject(localProjects.find(p => p.id === (requestedWorkspace || workspaceId))?.id || localProjects[0]?.id || ''); setLocalPath('');
    const prior = entry?.versions.find(v => v.id === entry.activeVersion)?.source;
    setSourceType(prior?.type === 'github' ? 'github' : 'local'); setRepository(prior && 'repository' in prior ? prior.repository || '' : ''); setCommit(''); setSubdirectory(prior && 'subdirectory' in prior ? prior.subdirectory || '' : ''); setImporting(true);
  };
  const status = (value: string) => ({ loadable: t('可装载', 'Loadable'), 'convertible-partial': t('部分可用', 'Partly supported'), unsupported: t('不支持', 'Unsupported'), 'missing-dependency': t('需要运行环境', 'Runtime required'), 'unverified-execution': t('待连接验证', 'Connection unverified') }[value] || value);
  // C05: reviewable storage for packages retained after uninstall. The
  // preview never deletes; cleanup runs only the previewed plan token.
  const [storage, setStorage] = useState<StoragePlan>(), [storageBusy, setStorageBusy] = useState(false), [storageResult, setStorageResult] = useState<StorageCleanup>();
  const [exportDestination, setExportDestination] = useState(''), [exportDir, setExportDir] = useState(''), [exportResults, setExportResults] = useState<ExportResult[]>(), [importResults, setImportResults] = useState<{ results: { id?: string; name?: string; status: string; detail?: string }[] }>();
  const [selectedExportIds, setSelectedExportIds] = useState<string[]>([]);
  const [converting, setConverting] = useState<Entry>(), [convertPlan, setConvertPlan] = useState<ConvertPlan>(), [convertOutput, setConvertOutput] = useState('');
  const kb = (bytes: number) => `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  const loadStorage = useCallback(async () => { const plan = await request<StoragePlan>('extension/storage/plan', {}); setStorage(plan); setStorageResult(undefined); }, [request]);
  useEffect(() => { if (connection === 'connected') void loadStorage().catch(() => {}); }, [loadStorage, connection]);
  const exportSelection = async (ids: string[]) => {
    setExportResults(undefined);
    try {
      const outcome = await request<{ results: ExportResult[] }>('extension/export', { destination: exportDestination.trim(), ids });
      setExportResults(outcome.results);
      setNotice(t('导出完成：%1 个成功。', 'Export finished: %1 succeeded.').replace('%1', String(outcome.results.filter((item) => item.status === 'exported').length)));
    } catch (cause) {
      const rows = (cause as { data?: { results?: unknown } } | null)?.data?.results;
      if (Array.isArray(rows)) setExportResults(rows.filter((row): row is ExportResult => Boolean(row && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.status === 'string' && (row.detail === undefined || typeof row.detail === 'string'))));
      throw cause;
    }
  };
  const table = (report: Report) => <div className="nw-extension-components">{report.components.map((component, i) => <div key={`${component.component}-${i}`}><span><strong>{component.name || component.component}</strong><small>{component.format}</small></span><span className="nw-extension-status" data-status={component.status}>{status(component.status)}</span><details><summary>{t('说明', 'Details')}</summary><p>{component.details}</p></details></div>)}</div>;
  return <section className="nw-extension-manager" aria-label={t('管理扩展', 'Manage extensions')}>
    <div className="nw-page-heading"><div><h1>{t('已安装扩展', 'Installed extensions')}</h1><p>{t('添加 Skill 或插件，按需启用，也可以回到之前的版本。', 'Add a Skill or plugin, enable it when needed, or return to an earlier version.')}</p></div><button className="nw-button" disabled={busy} onClick={() => startImport()}><Plus size={15} />{t('添加扩展', 'Add extension')}</button></div>
    {builtinSkills.filter(s => s.userModified && s.updateAvailable).map(s => (
      <p className="nw-extension-notice" key={s.name} role="status">
        <Check size={16} />
        {t(`内置技能“${s.name}”已有新版本。已为你保留自定义修改；如需更新可先备份修改再重置。`, `A newer version of built-in skill "${s.name}" is available. Your custom modifications are preserved; backup your changes if you wish to reset to the new version.`)}
      </p>
    ))}
    {recoveryError && <p className="nw-inline-error" role="alert">{recoveryError}</p>}{entries.filter(entry => entry.recoveryError).map(entry => <p className="nw-inline-error" key={entry.id} role="alert">{entry.name}: {entry.recoveryError}</p>)}{error && <p className="nw-inline-error" role="alert">{error}</p>}{notice && <p role="status" className="nw-extension-notice"><Check size={16} />{notice}</p>}
    {!entries.length && <div className="nw-extension-empty" role={loading ? 'status' : undefined}>{loading && connection === 'connected' ? <Loader2 size={26} className="nw-spin" /> : <Package size={28} strokeWidth={1.5} />}<strong>{loading ? connection === 'connected' ? t('正在读取扩展…', 'Loading extensions…') : t('等待连接工作引擎', 'Waiting for the engine') : t('还没有安装扩展', 'No extensions installed yet')}</strong><p>{t('从项目文件夹、ZIP 或固定 GitHub 版本添加扩展。', 'Import an extension from a project folder, ZIP, or fixed GitHub version.')}</p></div>}
    {entries.map(entry => <article className="nw-extension-entry" key={entry.id}><header><Package size={18} /><div><strong>{entry.name}</strong><small>{entry.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')} · {status(entry.report.status)}</small></div><button className="nw-button" disabled={busy} aria-pressed={entry.enabled} onClick={() => void action(async () => { await request('extension/enable', { id: entry.id, revision: entry.revision, enabled: !entry.enabled }); setNotice(entry.enabled ? t('扩展已停用。', 'Extension disabled.') : t('扩展已启用，技能列表已刷新。', 'Extension enabled and Skills refreshed.')); })}><Power size={14} />{entry.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}</button></header><details><summary>{t('包含的能力', 'Included capabilities')}<ChevronDown size={14} /></summary>{table(entry.report)}</details><footer><button className="nw-button" disabled={busy} onClick={() => startImport(entry)}><ArrowDownToLine size={14} />{t('更新', 'Update')}</button><button className="nw-button" disabled={busy || entry.versions.length < 2} onClick={() => { setHistory(entry); setVersion(entry.versions.find(v => v.id !== entry.activeVersion)?.id || ''); }}><History size={14} />{t('历史版本', 'Versions')}</button><button className="nw-button" disabled={!canTransferExtensions || busy || !entry.report.components.some(component => component.format === 'claude-commands' && component.status === 'convertible-partial')} title={!canTransferExtensions ? t('请在已连接工作引擎的桌面应用中转换为 Skill。', 'Convert to Skill in the desktop app with a connected engine.') : undefined} onClick={() => void action(async () => { setConverting(entry); setConvertPlan(await request<ConvertPlan>('extension/convert/plan', { entryId: entry.id })); })}><Wand2 size={14} />{t('转换为 Skill', 'Convert to Skills')}</button><button className="nw-icon" disabled={busy} aria-label={t('卸载扩展', 'Uninstall extension')} onClick={() => setRemoving(entry)}><Trash2 size={15} /></button></footer></article>)}
    {importing && <Modal title={updating ? t('更新扩展', 'Update extension') : t('添加扩展', 'Add extension')} close={() => setImporting(false)} busy={busy}><div className="nw-extension-import">
      <div className="nw-tabs"><button className={sourceType === 'local' ? 'is-active' : ''} disabled={busy} onClick={() => setSourceType('local')}><FolderOpen size={15} />{t('本地文件', 'Local files')}</button><button className={sourceType === 'github' ? 'is-active' : ''} disabled={busy} onClick={() => setSourceType('github')}><Github size={15} />{t('GitHub', 'GitHub')}</button></div>
      {sourceType === 'local' ? <><label className="nw-field">{t('项目', 'Project')}<select aria-label={t('项目', 'Project')} disabled={busy} value={project} onChange={e => setProject(e.target.value)}><option value="">{t('选择项目', 'Choose project')}</option>{localProjects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label><label className="nw-field">{t('项目内的文件夹或 ZIP 路径', 'Folder or ZIP path within the project')}<input disabled={busy} placeholder={t('extensions/my-skill', 'extensions/my-skill')} value={localPath} onChange={e => setLocalPath(e.target.value)} /></label><p className="nw-help">{localProjects.length ? t('留空可检查项目根目录。导入会保留原文件。', 'Leave the path empty to inspect the project root. Importing preserves the original files.') : t('先在侧栏新建项目并选择本地文件夹，再从中导入扩展。也可切换到 GitHub。', 'Create a project with a local folder in the sidebar before importing files, or switch to GitHub.')}</p></> : <><label className="nw-field">{t('仓库', 'Repository')}<input disabled={busy} placeholder={t('owner/repository', 'owner/repository')} value={repository} onChange={e => setRepository(e.target.value)} /></label><label className="nw-field">{t('固定版本（完整提交 SHA）', 'Fixed version (full commit SHA)')}<input disabled={busy} minLength={40} maxLength={40} value={commit} onChange={e => setCommit(e.target.value)} /></label><label className="nw-field">{t('仓库内的扩展目录（可选）', 'Extension folder in the repository (optional)')}<input disabled={busy} value={subdirectory} onChange={e => setSubdirectory(e.target.value)} /></label></>}
      {inspection && <><p className="nw-help">{inspection.files} {t('个文件', 'files')} · {(inspection.bytes / 1024).toFixed(1)} {t('KB', 'KB')}</p>{table(inspection.report)}<p className="nw-help">{t('安装后默认停用。启用只会装载受支持的能力；Claude 专属 Hooks 不会执行。', 'New installations start disabled. Enabling loads supported capabilities; Claude-specific hooks do not run.')}</p></>}
      {error && <p className="nw-inline-error" role="alert">{error}</p>}<div className="nw-dialog-actions"><button className="nw-button" disabled={busy || (sourceType === 'local' ? !project : !repository || commit.length !== 40)} onClick={() => void action(async () => setInspection(await request<Inspection>('extension/inspect', { source: source() })))}>{busy ? <Loader2 size={14} className="nw-spin" /> : <Check size={14} />}{t('检查兼容性', 'Inspect compatibility')}</button><button className="nw-button nw-button-primary" disabled={busy || !inspection || inspection.report.status === 'unsupported'} onClick={() => void action(async () => { await request('extension/install', { source: source(), expectedSha256: inspection!.sha256, ...(updating ? { id: updating.id, revision: updating.revision } : {}) }); setImporting(false); setNotice(updating ? t('扩展已更新，可从历史版本回退。', 'Extension updated. Earlier versions remain available.') : t('扩展已安装，启用后即可使用。', 'Extension installed. Enable it to use its capabilities.')); })}>{updating ? t('更新', 'Update') : t('安装', 'Install')}</button></div>
    </div></Modal>}
    {removing && <Modal title={t('卸载扩展', 'Uninstall extension')} close={() => setRemoving(undefined)} busy={busy}><p>{t(`卸载“${removing.name}”？原始文件和已下载版本会保留，已启用的能力会移除。`, `Uninstall “${removing.name}”? Original files and downloaded versions remain; active capabilities are removed.`)}</p>{error && <p className="nw-inline-error" role="alert">{error}</p>}<div className="nw-dialog-actions"><button className="nw-button" disabled={busy} onClick={() => setRemoving(undefined)}>{t('取消', 'Cancel')}</button><button className="nw-button" disabled={busy} onClick={() => void action(async () => { await request('extension/uninstall', { id: removing.id, revision: removing.revision }); setRemoving(undefined); })}>{t('卸载', 'Uninstall')}</button></div></Modal>}
    {history && <Modal title={t('历史版本', 'Extension versions')} close={() => setHistory(undefined)} busy={busy}><label className="nw-field">{t('恢复到', 'Restore version')}<select value={version} disabled={busy} onChange={e => setVersion(e.target.value)}>{history.versions.filter(v => v.id !== history.activeVersion).map(v => <option key={v.id} value={v.id}>{new Date(v.createdAt).toLocaleString()} · {v.sha256.slice(0, 10)}</option>)}</select></label><p className="nw-help">{t('恢复所选版本，并保留当前版本供以后切换。', 'Restore this version while keeping the current version available.')}</p>{error && <p className="nw-inline-error" role="alert">{error}</p>}<button className="nw-button nw-button-primary" disabled={busy || !version} onClick={() => void action(async () => { await request('extension/rollback', { id: history.id, revision: history.revision, version }); setHistory(undefined); setNotice(t('已恢复到所选版本。', 'Selected version restored.')); })}>{t('恢复此版本', 'Restore this version')}</button></Modal>}
    {converting && <Modal title={t('转换为 Skill', 'Convert commands to Skills')} close={() => setConverting(undefined)} busy={busy}>
      <p className="nw-help">{t('把 Claude 命令中的纯 Markdown 提示转换为独立 Skill：只迁移提示文本，shell 执行、hooks、权限与模型选择不会迁移，也不会执行任何文件内容。', 'Converts pure-Markdown Claude command prompts into standalone Skills: prompt text only. Shell execution, hooks, permissions and model choices are not migrated, and no file content is ever executed.')}</p>
      <label className="nw-field">{t('输出目录（新目录）', 'Output directory (a new folder)')}<input value={convertOutput} onChange={(event) => setConvertOutput(event.target.value)} /></label>
      {convertPlan && <ul className="nw-help" style={{ listStyle: 'none', padding: 0 }}>{convertPlan.items.map((item) => (
        <li key={item.command} style={{ marginBottom: 10, padding: '6px 8px', borderBottom: '1px solid var(--nw-border)' }}>
          <div>
            <strong>{item.command}</strong> → <code>skills/{item.skillName}</code>{' '}
            <span className="nw-extension-status" data-status={item.status}>
              {item.status === 'convertible' ? t('可转换', 'Convertible') : t('已拒绝', 'Refused')}
            </span>
          </div>
          {item.description && <div style={{ fontSize: '0.85em', color: 'var(--nw-muted)' }}>{item.description}</div>}
          {item.refusals?.length ? <div className="nw-inline-error">{t('拒绝原因', 'Refused')}: {item.refusals.join('；')}</div> : null}
          {item.notes?.length ? <div style={{ fontSize: '0.85em', color: 'var(--nw-muted)' }}>{t('未迁移项', 'Unmigrated')}: {item.notes.join('；')}</div> : null}
        </li>
      ))}</ul>}
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      <div className="nw-dialog-actions">
        <button className="nw-button" disabled={busy} onClick={() => void action(async () => setConvertPlan(await request<ConvertPlan>('extension/convert/plan', { entryId: converting.id })))}>{t('重新检查', 'Recheck')}</button>
        <button className="nw-button nw-button-primary" disabled={!canTransferExtensions || busy || !convertOutput.trim() || !convertPlan?.items.some((item) => item.status === 'convertible')} onClick={() => void action(async () => {
          const outcome = await request<{ results: { command: string; status: string; detail?: string }[] }>('extension/convert/perform', { entryId: converting.id, outputDir: convertOutput.trim(), expectedPackageSha256: convertPlan?.extension.packageSha256 });
          setConverting(undefined);
          setNotice(t('转换完成，可通过本地项目导入装载新 Skill。', 'Conversion finished — import the local project folder to load the new Skills.'));
          void outcome;
        })}>{t('开始转换', 'Convert')}</button>
      </div>
    </Modal>}
    <details className="nw-extension-storage"><summary>{t('导出与重建', 'Export and rebuild')}</summary>
      <p className="nw-help">{t('按固定版本导出选中的扩展（仅包内容与公开来源信息，不含 Home 数据、凭据或绝对路径）。导入先给出逐项计划，再经现有检查链安装并默认停用。被修改过或疑似嵌入凭据的包会被拒绝导出。', 'Export selected extensions at fixed versions (package content plus public source info only — no Home data, credentials, or absolute paths). Import shows a per-item plan first, then installs through the existing validation chain, disabled by default. Modified or credential-bearing packages are refused for export.')}</p>
      {!canTransferExtensions && <p className="nw-help" role="status">{t('请在已连接工作引擎的桌面应用中导出或导入扩展。', 'Export or import extensions in the desktop app with a connected engine.')}</p>}
      {entries.length > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', border: '1px solid var(--nw-border)', borderRadius: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{t('选择要导出的扩展', 'Select extensions to export')}</span>
            <button
              type="button"
              className="nw-button"
              style={{ fontSize: '0.8em', padding: '2px 8px' }}
              onClick={() => setSelectedExportIds(selectedExportIds.length === entries.length ? [] : entries.map((e) => e.id))}
            >
              {selectedExportIds.length === entries.length ? t('取消全选', 'Deselect all') : t('全选', 'Select all')}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {entries.map((entry) => (
              <label key={entry.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedExportIds.includes(entry.id)}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedExportIds([...selectedExportIds, entry.id]);
                    else setSelectedExportIds(selectedExportIds.filter((id) => id !== entry.id));
                  }}
                />
                <span>{entry.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="nw-preference-actions">
        <button className="nw-button" disabled={!canTransferExtensions || busy || !selectedExportIds.length || !exportDestination.trim()} onClick={() => void action(() => exportSelection(selectedExportIds))}>{t('导出所选扩展', 'Export selected extensions')}{selectedExportIds.length ? ` (${selectedExportIds.length})` : ''}</button>
        <button className="nw-button" disabled={!canTransferExtensions || busy || !entries.length || !exportDestination.trim()} onClick={() => void action(() => exportSelection(entries.map((entry) => entry.id)))}>{t('导出全部扩展', 'Export all extensions')}</button>
        <button className="nw-button" disabled={!canTransferExtensions || busy || !exportDir.trim()} onClick={() => void action(async () => {
          const plan = await request<{ items: { id?: string; name?: string; status: string; detail?: string }[] }>('extension/import/plan', { exportDir: exportDir.trim() });
          setImportResults({ results: plan.items });
        })}>{t('生成导入计划', 'Plan import')}</button>
        <button className="nw-button nw-button-primary" disabled={!canTransferExtensions || busy || !importResults || !importResults.results.some((item) => item.status === 'new')} onClick={() => void action(async () => {
          const outcome = await request<{ results: { id?: string; name?: string; status: string; detail?: string }[] }>('extension/import/perform', { exportDir: exportDir.trim(), ids: importResults!.results.filter((item) => item.status === 'new').map((item) => item.id) });
          setImportResults(outcome); await load(); await loadStorage().catch(() => {});
        })}>{t('执行导入', 'Perform import')}</button>
      </div>
      <label className="nw-field">{t('导出目标目录（新目录）', 'Export destination (a new folder)')}<input value={exportDestination} onChange={(event) => setExportDestination(event.target.value)} /></label>
      <label className="nw-field">{t('导出容器目录', 'Export container folder')}<input value={exportDir} onChange={(event) => { setExportDir(event.target.value); setImportResults(undefined); }} /></label>
      {exportResults && <ul className="nw-help">{exportResults.map((item) => <li key={item.id}>{item.name}: {item.status}{item.detail ? ` — ${item.detail}` : ''}</li>)}</ul>}
      {importResults && <ul className="nw-help">{importResults.results.map((item, index) => <li key={`${item.id}-${index}`}>{item.name || item.id}: {item.status}{item.detail ? ` — ${item.detail}` : ''}</li>)}</ul>}
    </details>
    <details className="nw-extension-storage"><summary>{t('包存储空间', 'Package storage')}{storage && storage.reclaimableBytes > 0 ? ` · ${t('可回收', 'reclaimable')} ${kb(storage.reclaimableBytes)}` : ''}</summary>
      <p className="nw-help">{t('卸载扩展后安装包会保留以便恢复。这里只回收已卸载的残留包和未引用的版本；已安装版本与其回滚引用始终保留，修改过的包不会自动删除。', 'Uninstalled extensions keep their packages for recovery. Only uninstalled leftovers and unreferenced versions are reclaimed here; installed versions and rollback references stay, and modified packages are never auto-deleted.')}</p>
      {storage && storage.protectedModified.length > 0 && <ul className="nw-help">{storage.protectedModified.map(item => <li key={`${item.id}-${item.versionId || ''}`}>{item.reason}</li>)}</ul>}
      <div className="nw-dialog-actions">
        <button className="nw-button" disabled={storageBusy || connection !== 'connected'} onClick={() => void action(loadStorage).then(() => setStorageResult(undefined))}><Loader2 size={14} className={storageBusy ? 'nw-spin' : ''} />{t('重新检查', 'Recheck')}</button>
        <button className="nw-button" disabled={storageBusy || !storage || storage.reclaimableBytes === 0 || Boolean(storageResult)} onClick={() => void action(async () => { setStorageBusy(true); try { const result = await request<StorageCleanup>('extension/storage/cleanup', { token: storage!.token }); setStorageResult(result); setNotice(t('已回收 %1 的扩展存储。', 'Reclaimed %1 of extension storage.').replace('%1', kb(result.freedBytes))); await loadStorage(); } finally { setStorageBusy(false); } })}>{t('回收 %1', 'Reclaim %1').replace('%1', kb(storage?.reclaimableBytes || 0))}</button>
      </div>
      {storageResult && <p className="nw-help" role="status">{t('已移除 %1 个残留包和 %2 个未引用版本。', 'Removed %1 leftover packages and %2 unreferenced versions.').replace('%1', String(storageResult.removedPackages)).replace('%2', String(storageResult.removedVersions))}</p>}
    </details>
  </section>;
}
