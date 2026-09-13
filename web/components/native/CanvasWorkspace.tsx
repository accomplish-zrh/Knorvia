'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { ArrowLeft, ArrowUpRight, Check, Clapperboard, Download, FolderOpen, Image as ImageIcon, LayoutGrid, Loader2, MessageSquare, Plus, Redo2, Save, Trash2, Type, Undo2, X , CopyPlus } from 'lucide-react';
import type { CanvasDocument, CanvasEdgeRole, CanvasGenerateResult, CanvasNode, CanvasNodeKind, CanvasSummary } from '@/lib/native-canvas';
import { validCanvasDraft } from '@/lib/native-canvas-recovery';
import { NativeClientError } from '@/lib/knorvia-native-types';
import { canvasEditable } from '@/lib/native-canvas';
import { canvasAgentContext, canvasConnectionIssue, canvasGraphKey, layoutCanvasNodes } from '@/lib/native-canvas-graph';
import { libraryKind, libraryMime, readLibraryFile, saveLibraryFile, type LibraryEntry } from '@/lib/native-library';
import { buildVariant, previewVariant, variantSourceKey } from '@/lib/native-canvas-variants';
import { studioFinished, type StudioProfile } from '@/lib/native-studio';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { StudioMedia } from './StudioMedia';
import { Modal } from './WorkbenchShell';
import '@xyflow/react/dist/style.css';
import './canvas-workspace.css';

type CardData = { item: CanvasNode; t: (zh: string, en: string) => string };
type FlowNode = Node<CardData, 'canvas'>;
const icons = { text: Type, asset: FolderOpen, image: ImageIcon, video: Clapperboard };
const roles: CanvasEdgeRole[] = ['context', 'reference', 'firstFrame', 'lastFrame'];
const roleLabels = { context: ['提示词', 'Prompt'], reference: ['参考图', 'Reference'], firstFrame: ['首帧', 'First frame'], lastFrame: ['尾帧', 'Last frame'] } as const;
const nodeLabels = { text: ['提示词', 'Prompt'], asset: ['参考素材', 'Reference'], image: ['图片生成', 'Image'], video: ['视频生成', 'Video'] } as const;
const nodePending = (node: CanvasNode) => !!node.jobId && (!node.job || !studioFinished(node.job) || node.job.phase === 'unknown' || !!node.job.remoteMayContinue);
const draftKey = (id: string) => `knorvia-canvas-draft:${id}`;
function cacheDraft(doc: CanvasDocument) { try { sessionStorage.setItem(draftKey(doc.id), JSON.stringify(doc)); } catch { /* The visible unsaved state remains authoritative. */ } }
function forgetDraft(id: string) { try { sessionStorage.removeItem(draftKey(id)); } catch { /* optional recovery cache */ } }
function exportCanvas(doc: CanvasDocument) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, ...canvasEditable(doc) }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${doc.title || 'Knorvia'}.knorvia-canvas.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReferencePreview({ item }: { item: CanvasNode }) {
  const { request, t } = useWorkbench();
  const [url, setUrl] = useState(''); const [failed, setFailed] = useState(false);
  const reference = item.reference;
  useEffect(() => {
    if (!reference) return;
    const abort = new AbortController(); let objectUrl = '';
    void (async () => {
      await Promise.resolve(); if (abort.signal.aborted) return; setUrl(''); setFailed(false);
      const result = await request<{ entry: LibraryEntry }>('library/read', { id: reference.id, version: reference.version, offset: 0 });
      if (result.entry.size > 20 * 1024 * 1024 || libraryKind(result.entry.name) !== 'image') throw Error('Preview unavailable');
      const file = await readLibraryFile(request, result.entry, reference.version, abort.signal);
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([file.bytes], { type: libraryMime(result.entry.name) })); setUrl(objectUrl);
    })().catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request, reference?.id, reference?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Library previews use revocable local blob URLs.
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={reference?.name || item.title} draggable={false} /> : <div className="nc-media-empty"><ImageIcon size={24} /><span>{failed ? t('素材预览不可用', 'Preview unavailable') : t('正在读取素材', 'Loading reference')}</span></div>;
}

const CanvasCard = memo(function CanvasCard({ data, selected }: NodeProps<FlowNode>) {
  const { item, t } = data; const Icon = icons[item.kind];
  const incoming = item.kind === 'image' ? ['context', 'reference'] : item.kind === 'video' ? ['context', 'firstFrame', 'lastFrame'] : item.kind === 'text' ? ['context'] : [];
  return <article className={`nc-card nc-card-${item.kind} ${selected ? 'is-selected' : ''}`}>
    <header className="nc-card-drag"><Icon size={15} /><strong>{item.title || t(nodeLabels[item.kind][0], nodeLabels[item.kind][1])}</strong><span>{t(nodeLabels[item.kind][0], nodeLabels[item.kind][1])}</span></header>
    {item.kind === 'text' ? <p className="nc-card-prompt">{item.prompt || t('写下想法、风格或场景描述…', 'Add an idea, a style or a scene…')}</p> : item.kind === 'asset' && item.reference ? <div className="nc-card-media nodrag"><ReferencePreview item={item} /></div> : item.job?.outputs?.length ? <div className="nc-card-media nodrag nowheel"><StudioMedia job={item.job} /></div> : <div className="nc-media-empty"><Icon size={30} strokeWidth={1.25} /><p>{item.prompt || t('连接素材，再开始创作', 'Connect references, then create')}</p></div>}
    {item.job && <div className={`nc-job-state ${!studioFinished(item.job) ? 'is-running' : ''}`}>{!studioFinished(item.job) ? <Loader2 size={13} className="nw-spin" /> : item.job.status === 'succeeded' ? <Check size={13} /> : <X size={13} />}<span>{item.job.phase === 'unknown' ? t('结果未知', 'Outcome unknown') : item.job.status === 'succeeded' ? t('已生成', 'Created') : item.job.status === 'failed' ? t('生成失败', 'Failed') : item.job.status === 'cancelled' ? t('已停止', 'Stopped') : t('正在生成', 'Generating')}</span></div>}
    {incoming.map((role, index) => <Handle key={role} type="target" id={role} position={Position.Left} style={{ top: 64 + index * 43 }} title={t(roleLabels[role as CanvasEdgeRole][0], roleLabels[role as CanvasEdgeRole][1])} aria-label={t(roleLabels[role as CanvasEdgeRole][0], roleLabels[role as CanvasEdgeRole][1])} />)}
    <Handle type="source" id="output" position={Position.Right} style={{ top: '50%' }} title={t('连接到下一步', 'Connect to the next step')} />
  </article>;
});
const nodeTypes = { canvas: CanvasCard };

export function CanvasWorkspace({ threadId, initialId, active = true, onSelect, onClose, onAskAgent }: { threadId?: string; initialId?: string; active?: boolean; onSelect?: (id: string) => void; onClose?: () => void; onAskAgent?: (text: string, id: string) => void }) {
  const { request, t, connection, setNotice } = useWorkbench();
  const [doc, setDoc] = useState<CanvasDocument>(); const current = useRef<CanvasDocument | undefined>(undefined);
  const [boards, setBoards] = useState<CanvasSummary[]>([]); const [profiles, setProfiles] = useState<StudioProfile[]>([]);
  const [selectedIds, selectIds] = useState<string[]>([]); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false); const [saveProblem, setSaveProblem] = useState(false); const [savedKey, setSavedKey] = useState(''); const saved = useRef('');
  const saving = useRef<Promise<CanvasDocument | undefined> | null>(null); const actionLock = useRef(false); const loadToken = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false); const [library, setLibrary] = useState<LibraryEntry[]>([]); const [query, setQuery] = useState('');
  const [history, setHistory] = useState<{ undo: CanvasDocument[]; redo: CanvasDocument[] }>({ undo: [], redo: [] });
  type VariantReview = { document: CanvasDocument; ids: string[]; key: string };
  const [variantReview, setVariantReview] = useState<VariantReview>();
  const variantRef = useRef<VariantReview | undefined>(undefined);
  const variantPreview = useMemo(() => variantReview ? previewVariant(variantReview.document, variantReview.ids) : undefined, [variantReview]);
  const closeVariant = () => { variantRef.current = undefined; setVariantReview(undefined); };
  const [nodeLink, setNodeLink] = useState(''); const [linkRole, setLinkRole] = useState<CanvasEdgeRole>('context');
  const flow = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null); const importInput = useRef<HTMLInputElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const fitCanvas = useCallback(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void flow.current?.fitView({ padding: .3, maxZoom: 1, duration: reduced ? 0 : 240 });
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !doc?.id || !active) return;
    let width = element.clientWidth, height = element.clientHeight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect;
      if (next.width < 1 || next.height < 1) return;
      // Fit when the panel changes substantially; ordinary editing and panning
      // keep the user's camera position.
      if (Math.abs(next.width - width) / Math.max(width, 1) < .25 && Math.abs(next.height - height) / Math.max(height, 1) < .25) return;
      width = next.width; height = next.height;
      clearTimeout(timer); timer = setTimeout(fitCanvas, 120);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [doc?.id, active, fitCanvas]);
  const attempts = useRef(new Map<string, string>()); const creating = useRef<{ fingerprint: string; key: string } | undefined>(undefined); const dirty = !!doc && canvasGraphKey(doc) !== savedKey;
  const setDocument = useCallback((value: CanvasDocument) => { current.current = value; setDoc(value); }, []);
  const acceptSaved = useCallback((value: CanvasDocument) => { saved.current = canvasGraphKey(value); setSavedKey(saved.current); }, []);
  const remember = useCallback(() => { if (current.current) { const before = current.current; setHistory(h => ({ undo: [...h.undo.slice(-39), before], redo: [] })); } }, []);
  const edit = useCallback((fn: (value: CanvasDocument) => CanvasDocument, undo = true) => {
    if (!current.current) return; setSaveProblem(false); if (undo) remember(); const value = fn(current.current); setDocument(value); cacheDraft(value);
  }, [remember, setDocument]);
  const refreshList = useCallback(async () => { const result = await request<{ canvases: CanvasSummary[] }>('studio/canvas/list', {}); setBoards(result.canvases); return result.canvases; }, [request]);
  const load = useCallback(async (id: string, discard = false) => {
    const token = ++loadToken.current; setBusy('load'); setError('');
    try {
      const fresh = await request<CanvasDocument>('studio/canvas/read', { id }); if (token !== loadToken.current) return;
      let recovered: CanvasDocument | undefined;
      if (!discard) try { const value = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null'); if (validCanvasDraft(value) && value.id === fresh.id) recovered = value; } catch { /* malformed recovery data is ignored */ }
      else forgetDraft(id);
      acceptSaved(fresh); setDocument(recovered ? { ...recovered, nodes: recovered.nodes.map(n => ({ ...n, jobId: fresh.nodes.find(f => f.id === n.id)?.jobId, job: fresh.nodes.find(f => f.id === n.id)?.job })) } : fresh);
      setConflict(!!recovered && recovered.revision !== fresh.revision);
      if (recovered && recovered.revision !== fresh.revision) setError(t('另一个窗口已更新画布。你的草稿仍在，可先导出，再读取最新版本。', 'Another window updated this canvas. Export your draft before reloading the latest version.'));
      selectIds([]); setSaveProblem(false); setHistory({ undo: [], redo: [] }); onSelect?.(id);
    } catch (e) { setError(errorText(e)); } finally { if (token === loadToken.current) setBusy(''); }
  }, [request, acceptSaved, setDocument, onSelect, t]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    if (connection !== 'connected') return;
    let disposed = false;
    void Promise.all([refreshList(), request<{ profiles: StudioProfile[] }>('studio/models')]).then(([items, models]) => {
      if (disposed) return; setProfiles(models.profiles); const id = initialId || items[0]?.id; if (id && !current.current) void loadRef.current(id);
    }).catch(e => { if (!disposed) setError(errorText(e)); });
    return () => { disposed = true; };
  }, [connection, refreshList, request, initialId]);

  const save = useCallback(async (): Promise<CanvasDocument | undefined> => {
    if (saving.current) return saving.current;
    const snapshot = current.current; if (!snapshot || conflict) return undefined;
    if (canvasGraphKey(snapshot) === saved.current) return snapshot;
    const promise = (async () => {
      setBusy('save'); setSaveProblem(false);
      try {
        const result = await request<CanvasDocument>('studio/canvas/save', { id: snapshot.id, revision: snapshot.revision, ...canvasEditable(snapshot) });
        acceptSaved(result); setError('');
        if (current.current?.id === snapshot.id) {
          if (canvasGraphKey(current.current) === canvasGraphKey(snapshot)) { setDocument(result); forgetDraft(result.id); }
          else { const next = { ...current.current, revision: result.revision, nodes: current.current.nodes.map(n => ({ ...n, jobId: result.nodes.find(f => f.id === n.id)?.jobId, job: result.nodes.find(f => f.id === n.id)?.job })) }; setDocument(next); cacheDraft(next); }
        }
        void refreshList().catch(() => {}); return result;
      } catch (e) { setError(errorText(e)); setSaveProblem(true); setConflict(e instanceof NativeClientError && e.code === -32005 || /另一个窗口|版本冲突/.test(errorText(e))); return undefined; }
      finally { saving.current = null; setBusy(''); }
    })(); saving.current = promise; return promise;
  }, [request, conflict, acceptSaved, setDocument, refreshList]);
  useEffect(() => { if (!dirty || conflict || saveProblem || busy || dragging || !active) return; const timer = setTimeout(() => { void save(); }, 1000); return () => clearTimeout(timer); }, [doc, dirty, conflict, saveProblem, busy, dragging, active, save]);
  useEffect(() => {
    if (!doc?.id || !active || connection !== 'connected') return;
    let cancelled = false, polling = false;
    const timer = setInterval(async () => {
      if (document.hidden || polling || saving.current || actionLock.current) return; polling = true;
      try {
        const fresh = await request<CanvasDocument>('studio/canvas/read', { id: doc.id });
        const local = current.current; if (cancelled || local?.id !== fresh.id) return;
        if (canvasGraphKey(local) === saved.current) { acceptSaved(fresh); setDocument(fresh); }
        else if (fresh.revision !== local.revision) { setConflict(true); setError(t('画布有新版本。先导出草稿，或读取最新版本后继续。', 'This canvas has a new revision. Export your draft or reload before editing.')); }
      } catch (e) { if (!cancelled) setError(errorText(e)); } finally { polling = false; }
    }, 4000); return () => { cancelled = true; clearInterval(timer); };
  }, [doc?.id, active, connection, request, acceptSaved, setDocument, t]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (current.current && canvasGraphKey(current.current) !== saved.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);

  const create = async (input: Record<string, unknown> = {}) => {
    if (actionLock.current) return; actionLock.current = true;
    try { if (current.current && (!(await save()) || canvasGraphKey(current.current) !== saved.current)) return; setBusy('create'); setError('');
      const body = { title: t('未命名画布', 'Untitled canvas'), ...(threadId ? { threadId } : {}), ...input }; const fingerprint = JSON.stringify(body);
      if (creating.current?.fingerprint !== fingerprint) creating.current = { fingerprint, key: crypto.randomUUID() };
      const result = await request<CanvasDocument>('studio/canvas/create', { ...body, idempotencyKey: creating.current.key });
      creating.current = undefined; acceptSaved(result); setDocument(result); setConflict(false); selectIds([]); setHistory({ undo: [], redo: [] }); onSelect?.(result.id); await refreshList();
    } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(''); }
  };
  const addNode = (kind: CanvasNodeKind, reference?: CanvasNode['reference']) => {
    if (!current.current || current.current.nodes.length >= 80) return;
    const bounds = viewport.current?.getBoundingClientRect();
    const point = bounds && flow.current ? flow.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2 - 130, y: bounds.top + bounds.height / 2 - 100 }) : { x: 100, y: 100 };
    const id = crypto.randomUUID(); const node: CanvasNode = { id, kind, title: reference?.name || t(nodeLabels[kind][0], nodeLabels[kind][1]), x: Math.round(point.x), y: Math.round(point.y), prompt: '', ...(reference ? { reference } : {}), ...(['image', 'video'].includes(kind) ? { profileId: profiles.find(p => p.kind === kind)?.id || '', settings: { size: kind === 'image' ? '1024x1024' : '1280x720', aspect: kind === 'image' ? '1:1' : '16:9', seconds: 4, count: 1, quality: 'auto' } } : {}) };
    edit(value => ({ ...value, nodes: [...value.nodes, node] })); selectIds([id]);
  };
  const connect = useCallback((c: Connection) => {
    if (!current.current || !c.source || !c.target) return;
    const edge = { id: crypto.randomUUID(), from: c.source, to: c.target, role: (c.targetHandle || 'context') as CanvasEdgeRole };
    const issue = canvasConnectionIssue(current.current.nodes, current.current.edges, edge); if (issue) { setError(issue); return; }
    edit(value => ({ ...value, edges: [...value.edges, edge] })); setError('');
  }, [edit]);
  const removeNode = (id: string) => { edit(value => ({ ...value, nodes: value.nodes.filter(n => n.id !== id), edges: value.edges.filter(e => e.from !== id && e.to !== id) })); selectIds([]); };

  // B19: one-shot copy of the selected subgraph as an unexecuted variant.
  // Fresh ids, only legal internal links, fixed asset versions kept, and no
  // job/result identity — so copying never triggers paid generation. The
  // whole copy is one edit step: a single undo restores it completely.
  const copyVariant = () => {
    if (!current.current || !selectedIds.length || locked) return;
    const review = { document: structuredClone(current.current), ids: [...selectedIds], key: variantSourceKey(current.current) };
    variantRef.current = review; setVariantReview(review);
  };
  const confirmVariant = () => {
    const review = variantRef.current, source = current.current;
    if (!review || !source || locked || saving.current) return;
    if (variantSourceKey(source) !== review.key) { setError(t('画布已变化，请关闭后重新预览变体。', 'The canvas changed. Close this preview and review the variant again.')); return; }
    const result = buildVariant(source, review.ids);
    if (!result.ok) {
      setError(result.reason === 'limit'
        ? t('画布最多 80 个节点，放不下这份副本。', 'The canvas holds at most 80 nodes; this copy does not fit.')
        : result.reason === 'identity' ? t('未能创建唯一节点编号，请重试。', 'Could not create unique node identities. Please retry.') : t('请先选择要复制的节点。', 'Select nodes to copy first.'));
      return;
    }
    closeVariant();
    edit(value => ({ ...value, nodes: [...value.nodes, ...result.nodes], edges: [...value.edges, ...result.edges] }));
    selectIds(result.nodes.map(node => node.id));
    setNotice(t(
      '已复制 ' + result.nodes.length + ' 个节点、' + result.edges.length + ' 条连线为变体（未复制 ' + result.dropped + ' 条外部连线，不携带运行状态）。',
      'Copied ' + result.nodes.length + ' nodes and ' + result.edges.length + ' links as a variant (' + result.dropped + ' outside links not copied; no run state carried).',
    ));
  };
  const generate = async (nodeId: string) => {
    if (actionLock.current) return; actionLock.current = true;
    try {
      const latest = await save(); if (!latest || canvasGraphKey(current.current!) !== saved.current) return;
      setBusy('generate'); setError(''); const key = `${latest.id}:${nodeId}`; let previous = attempts.current.get(key);
      try { previous ||= localStorage.getItem(`knorvia-canvas-attempt:${key}`) || undefined; } catch { /* retain the in-memory attempt */ }
      const token = previous && /^[a-f0-9-]{36}$/i.test(previous) ? previous : crypto.randomUUID(); attempts.current.set(key, token);
      try { localStorage.setItem(`knorvia-canvas-attempt:${key}`, token); } catch { /* the server still guards pending jobs */ }
      const result = await request<CanvasGenerateResult>('studio/canvas/generate', { id: latest.id, nodeId, revision: latest.revision, idempotencyKey: token });
      acceptSaved(result.canvas); setDocument(result.canvas); forgetDraft(latest.id); attempts.current.delete(key); try { localStorage.removeItem(`knorvia-canvas-attempt:${key}`); } catch { /* retrying this token remains safe */ }
      setNotice(t('节点已加入创作队列', 'Node added to the creation queue'));
    } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(''); }
  };
  const openLibrary = async () => { setLibraryOpen(true); setQuery(''); try { const value = await request<{ entries: LibraryEntry[] }>('library/list'); setLibrary(value.entries.filter(e => !e.trashedAt && !e.folder && libraryKind(e.name) === 'image')); } catch (e) { setError(errorText(e)); } };
  const upload = async (files: File[]) => {
    if (!doc || actionLock.current) return; actionLock.current = true; setBusy('upload');
    try { for (const file of files.slice(0, Math.min(6, 80 - doc.nodes.length))) { if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) throw Error(t('请使用 20 MB 以内的图片', 'Use images up to 20 MB')); const entry = await saveLibraryFile(request, `画布素材/${crypto.randomUUID()}-${file.name.replace(/[\\/:*?"<>|]/g, '_')}`, file); addNode('asset', { id: entry.id, version: entry.sha256, name: entry.name }); } } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(''); }
  };
  const undo = (direction: 'undo' | 'redo') => {
    const target = history[direction].at(-1); if (!target || !doc) return;
    setHistory(h => direction === 'undo' ? { undo: h.undo.slice(0, -1), redo: [...h.redo, doc] } : { undo: [...h.undo, doc], redo: h.redo.slice(0, -1) });
    const next = { ...target, revision: doc.revision, nodes: target.nodes.map(n => ({ ...n, jobId: doc.nodes.find(v => v.id === n.id)?.jobId, job: doc.nodes.find(v => v.id === n.id)?.job })) }; setDocument(next); cacheDraft(next);
  };
  const flowNodes = useMemo<FlowNode[]>(() => (doc?.nodes || []).map(item => ({ id: item.id, type: 'canvas', position: { x: item.x, y: item.y }, measured: measured[item.id], data: { item, t }, selected: selectedIds.includes(item.id), dragHandle: '.nc-card-drag', width: 270, deletable: !nodePending(item) })), [doc?.nodes, t, selectedIds, measured]);
  const flowEdges = useMemo<Edge[]>(() => (doc?.edges || []).map(edge => ({ id: edge.id, source: edge.from, target: edge.to, sourceHandle: 'output', targetHandle: edge.role, label: t(roleLabels[edge.role][0], roleLabels[edge.role][1]), type: 'default', animated: false, style: { strokeWidth: 1.6 } })), [doc?.edges, t]);
  const selected = doc?.nodes.find(n => n.id === selectedIds[0]);
  const availableRoles = roles.filter(r => selected?.kind === 'text' ? r === 'context' : selected?.kind === 'image' ? ['context', 'reference'].includes(r) : r !== 'reference');
  const effectiveRole = availableRoles.includes(linkRole) ? linkRole : 'context';
  const patchNode = (patch: Partial<CanvasNode>) => { if (selected) edit(value => ({ ...value, nodes: value.nodes.map(n => n.id === selected.id ? { ...n, ...patch } : n) })); };
  const locked = (!!busy && busy !== 'save') || conflict || connection !== 'connected';
  return <section className="nc-workspace" aria-label={t('创作画布', 'Creative canvas')}>
    <header className="nc-header"><div className="nc-heading">{onClose && <button className="nw-icon" aria-label={t('返回创作台', 'Back to studio')} onClick={async () => { if (!doc || await save() && current.current && canvasGraphKey(current.current) === saved.current) onClose(); }}><ArrowLeft size={18} /></button>}<LayoutGrid size={20} /><div><strong>{t('创作画布', 'Creative canvas')}</strong><span>{t('让想法彼此连接', 'Connect your ideas')}</span></div></div><div className="nc-header-actions"><button className="nw-icon" title={t('导入画布', 'Import canvas')} aria-label={t('导入画布', 'Import canvas')} onClick={() => importInput.current?.click()} disabled={locked}><FolderOpen size={17} /></button><button className="nw-button" disabled={locked} onClick={() => void create()}><Plus size={15} />{t('新画布', 'New canvas')}</button></div></header>
    <input hidden type="file" ref={importInput} accept=".json" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 2 * 1024 * 1024) throw Error(t('画布文件过大', 'Canvas file is too large')); const value = JSON.parse(await file.text()); if (value.schemaVersion !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw Error(t('不是有效的画布文件', 'Invalid canvas document')); await create({ ...canvasEditable(value), title: value.title || file.name }); } catch (error) { setError(errorText(error)); } }} />
    <input hidden type="file" ref={fileInput} accept="image/*" multiple onChange={e => { void upload(Array.from(e.target.files || [])); e.target.value = ''; }} />
    {error && <div className="nc-error" role="alert"><span>{error}</span>{doc && conflict && <><button onClick={() => exportCanvas(doc)}>{t('导出草稿', 'Export draft')}</button><button onClick={() => void load(doc.id, true)}>{t('读取最新', 'Reload latest')}</button></>}<button className="nw-icon" aria-label={t('关闭提示', 'Dismiss')} onClick={() => setError('')}><X size={14} /></button></div>}
    {!doc ? <div className="nc-empty"><div className="nc-empty-mark"><Type size={25} /><span /><ImageIcon size={30} /><span /><Clapperboard size={25} /></div><h2>{t('把灵感，连成作品。', 'From connected ideas to finished work.')}</h2><p>{t('放入提示词和参考素材，让图片、视频与 Agent 在同一张画布上协作。', 'Arrange prompts and references. Create images and videos with your Agent on one canvas.')}</p><button className="nw-button nw-button-primary" disabled={locked} onClick={() => void create()}>{busy ? <Loader2 size={16} className="nw-spin" /> : <Plus size={17} />}{t('开始一张画布', 'Start a canvas')}</button>{boards.length > 0 && <div className="nc-board-list">{boards.map(board => <button key={board.id} onClick={() => void load(board.id)}><LayoutGrid size={16} />{board.title}<span>{board.nodeCount}</span></button>)}</div>}</div> : <>
      <div className="nc-document-bar"><input aria-label={t('画布名称', 'Canvas name')} value={doc.title} maxLength={120} disabled={locked} onChange={e => edit(v => ({ ...v, title: e.target.value }))} /><span className={`nc-save-state ${conflict ? 'is-warning' : ''}`} role="status">{busy === 'save' ? <><Loader2 size={12} className="nw-spin" />{t('保存中', 'Saving')}</> : conflict ? t('草稿已保留', 'Draft kept') : dirty ? t('尚未保存', 'Unsaved') : <><Check size={12} />{t('已保存', 'Saved')}</>}</span><button className="nw-icon" aria-label={t('保存画布', 'Save canvas')} disabled={!dirty || locked} onClick={() => void save()}><Save size={15} /></button><button className="nw-icon" aria-label={t('导出画布', 'Export canvas')} onClick={() => exportCanvas(doc)}><Download size={15} /></button><select aria-label={t('切换画布', 'Switch canvas')} value={doc.id} disabled={locked || dirty} onChange={e => void load(e.target.value)}>{[...boards.filter(b => b.id !== doc.id), { ...doc, nodeCount: doc.nodes.length }].map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select></div>
      <div className="nc-body">
        <div className="nc-viewport" ref={viewport} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void upload(Array.from(e.dataTransfer.files)); } }}>
          <ReactFlow<FlowNode, Edge> key={doc.id} nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance; }} minZoom={.2} maxZoom={2} fitView fitViewOptions={{ padding: .3, maxZoom: 1 }} nodesDraggable={!locked} nodesConnectable={!locked} deleteKeyCode={null} onNodeDragStart={() => { remember(); setDragging(true); }} onNodeDragStop={() => setDragging(false)} onNodesChange={changes => {
            const sizes = changes.filter(c => c.type === 'dimensions' && c.dimensions);
            if (sizes.length) setMeasured(previous => {
              const next: typeof previous = {};
              for (const node of current.current?.nodes || []) {
                const size = sizes.find(c => c.type === 'dimensions' && c.id === node.id);
                const value = size?.type === 'dimensions' ? size.dimensions : previous[node.id];
                if (value) next[node.id] = value;
              }
              return next;
            });
            const positions = changes.filter(c => c.type === 'position'); const selections = changes.filter(c => c.type === 'select'); if (selections.length) selectIds(ids => { const next = new Set(ids); for (const c of selections) if (c.type === 'select') { if (c.selected) next.add(c.id); else next.delete(c.id); } return [...next]; }); if (positions.length && !locked) edit(v => ({ ...v, nodes: v.nodes.map(n => { const c = positions.find(p => p.type === 'position' && p.id === n.id); return c?.type === 'position' && c.position ? { ...n, x: Math.round(c.position.x), y: Math.round(c.position.y) } : n; }) }), false); }} onConnect={connect} onPaneClick={() => selectIds([])} onEdgeClick={(_, edge) => { if (!locked) edit(v => ({ ...v, edges: v.edges.filter(e => e.id !== edge.id) })); }} onlyRenderVisibleElements attributionPosition="bottom-left">
            <Background gap={22} size={1} color="var(--nc-grid)" /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="var(--nc-minimap)" maskColor="var(--nc-minimap-mask)" />
          </ReactFlow>
          <div className="nc-tools" role="toolbar" aria-label={t('画布工具', 'Canvas tools')}><button aria-label={t('提示词', 'Prompt')} title={t('提示词', 'Prompt')} disabled={locked || doc.nodes.length >= 80} onClick={() => addNode('text')}><Type size={18} /><span>{t('提示词', 'Prompt')}</span></button><button aria-label={t('素材', 'Reference')} title={t('素材', 'Reference')} disabled={locked || doc.nodes.length >= 80} onClick={() => void openLibrary()}><FolderOpen size={18} /><span>{t('素材', 'Reference')}</span></button><button aria-label={t('图片', 'Image')} title={t('图片', 'Image')} disabled={locked || doc.nodes.length >= 80} onClick={() => addNode('image')}><ImageIcon size={18} /><span>{t('图片', 'Image')}</span></button><button aria-label={t('视频', 'Video')} title={t('视频', 'Video')} disabled={locked || doc.nodes.length >= 80} onClick={() => addNode('video')}><Clapperboard size={18} /><span>{t('视频', 'Video')}</span></button><i /><button title={t('自动排布', 'Arrange nodes')} aria-label={t('自动排布', 'Arrange nodes')} disabled={locked || !doc.nodes.length} onClick={() => { edit(v => ({ ...v, nodes: layoutCanvasNodes(v.nodes, v.edges) })); setTimeout(fitCanvas, 60); }}><LayoutGrid size={17} /></button><button title={t('复制选中子图为变体', 'Copy selected subgraph as variant')} aria-label={t('复制选中子图为变体', 'Copy selected subgraph as variant')} disabled={locked || !selectedIds.length} onClick={copyVariant}><CopyPlus size={17} /></button><button aria-label={t('撤销', 'Undo')} disabled={locked || !history.undo.length} onClick={() => undo('undo')}><Undo2 size={17} /></button><button aria-label={t('重做', 'Redo')} disabled={locked || !history.redo.length} onClick={() => undo('redo')}><Redo2 size={17} /></button></div>
          {!doc.nodes.length && <div className="nc-board-hint"><ArrowUpRight size={22} /><p>{t('从一段提示词或一张参考图开始', 'Start with a prompt or a reference image')}</p><span>{t('也可以把图片拖到这里', 'You can drop images here, too')}</span></div>}
          <div className="nc-canvas-caption">{t('拖动卡片 · 滚轮缩放 · 点击连线移除', 'Drag cards · Scroll to zoom · Click a wire to remove')}</div>
        </div>
        <aside className="nc-inspector" aria-label={t('节点详情', 'Node details')}>
          {selected ? <><header><span>{t(nodeLabels[selected.kind][0], nodeLabels[selected.kind][1])}</span><button className="nw-icon" aria-label={t('取消选中', 'Deselect')} onClick={() => selectIds([])}><X size={15} /></button></header><label>{t('名称', 'Name')}<input value={selected.title} maxLength={120} disabled={locked} onChange={e => patchNode({ title: e.target.value })} /></label>{selected.kind !== 'asset' && <label>{t('提示词', 'Prompt')}<textarea value={selected.prompt || ''} maxLength={8000} rows={5} disabled={locked} placeholder={t('描述你想要的内容…', 'Describe what you want…')} onChange={e => patchNode({ prompt: e.target.value })} /></label>}
            {['image', 'video'].includes(selected.kind) && <><label>{t('模型', 'Model')}<select value={selected.profileId || ''} disabled={locked} onChange={e => patchNode({ profileId: e.target.value })}><option value="">{t('选择已配置模型', 'Choose a connected model')}</option>{profiles.filter(p => p.kind === selected.kind).map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label><div className="nc-input-row"><label>{t('尺寸', 'Size')}<input value={selected.settings?.size || ''} placeholder={selected.kind === 'image' ? '1024x1024' : '1280x720'} disabled={locked} onChange={e => patchNode({ settings: { ...selected.settings, size: e.target.value } })} /></label>{selected.kind === 'video' && <label>{t('秒数', 'Seconds')}<input type="number" min={1} max={60} value={selected.settings?.seconds ?? 4} disabled={locked} onChange={e => patchNode({ settings: { ...selected.settings, seconds: Number(e.target.value) } })} /></label>}</div></>}
            {selected.reference && <p className="nc-reference-name"><FolderOpen size={14} />{selected.reference.name || selected.reference.id}</p>}
            <div className="nc-connections"><h3>{t('上游连接', 'Inputs')}</h3>{doc.edges.filter(e => e.to === selected.id).map(edge => <div key={edge.id}><span>{doc.nodes.find(n => n.id === edge.from)?.title}</span><small>{t(roleLabels[edge.role][0], roleLabels[edge.role][1])}</small><button className="nw-icon" aria-label={t('移除此连接', 'Remove connection')} disabled={locked} onClick={() => edit(v => ({ ...v, edges: v.edges.filter(e => e.id !== edge.id) }))}><X size={12} /></button></div>)}{selected.kind !== 'asset' && <><select aria-label={t('选择上游节点', 'Choose an input node')} value={nodeLink} onChange={e => setNodeLink(e.target.value)}><option value="">{t('选择上游节点…', 'Choose an input…')}</option>{doc.nodes.filter(n => n.id !== selected.id).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select><div className="nc-input-row"><select aria-label={t('连接用途', 'Input role')} value={effectiveRole} onChange={e => setLinkRole(e.target.value as CanvasEdgeRole)}>{availableRoles.map(r => <option key={r} value={r}>{t(roleLabels[r][0], roleLabels[r][1])}</option>)}</select><button className="nw-button" disabled={locked || !nodeLink} onClick={() => connect({ source: nodeLink, target: selected.id, sourceHandle: 'output', targetHandle: effectiveRole })}>{t('连接', 'Connect')}</button></div></>}</div>
            {selected.job?.error && <p className="nc-node-error" role="alert">{selected.job.error}</p>}{['image', 'video'].includes(selected.kind) && <><button className="nw-button nw-button-primary nc-generate" disabled={locked || !selected.profileId || nodePending(selected)} onClick={() => void generate(selected.id)}>{busy === 'generate' ? <Loader2 className="nw-spin" size={16} /> : <ArrowUpRight size={17} />}{selected.job ? t('再次生成', 'Generate again') : t('生成这个节点', 'Generate this node')}</button><p className="nc-help">{t('使用所选模型的额度；连接素材不会自动生成。', 'Uses your selected model. Connecting references does not start generation.')}</p></>}
            <button className="nc-remove" disabled={locked || nodePending(selected)} onClick={() => removeNode(selected.id)}><Trash2 size={14} />{t('移除节点', 'Remove node')}</button>
          </> : <><header><span>{t('共同上下文', 'Shared context')}</span><MessageSquare size={16} /></header><p className="nc-help">{t('统一风格、角色与要求。每个生成节点都会带上这些内容。', 'Style, characters and constraints included in each generation.')}</p><textarea aria-label={t('共同提示词', 'Shared prompt')} rows={6} value={doc.globalPrompt} maxLength={8000} disabled={locked} placeholder={t('例如：同一角色，纪实摄影，温柔的午后光线…', 'For example: the same character, documentary photography, soft afternoon light…')} onChange={e => edit(v => ({ ...v, globalPrompt: e.target.value }))} /><div className="nc-guide"><strong>{t('连线就是上下文', 'Connections carry context')}</strong><p>{t('文字 → 提示词\n图片 → 参考图 / 首尾帧\n视频 → 抽取尾帧，接下一段', 'Text → prompt\nImage → reference / boundary frames\nVideo → last frame for the next shot')}</p></div></>}
          {onAskAgent && <button className="nw-button nc-agent" disabled={locked} onClick={async () => { const latest = await save(); if (latest && current.current && canvasGraphKey(current.current) === saved.current) onAskAgent(canvasAgentContext(latest, selectedIds), latest.id); }}><MessageSquare size={16} />{t('引用到对话', 'Use in conversation')}</button>}
        </aside>
      </div>
    </>}
    {variantReview && variantPreview && <Modal title={t('预览画布变体', 'Preview canvas variant')} close={closeVariant}>
      <div className="nc-variant-review">
        <p>{t(`复制 ${variantPreview.nodes.length} 个节点和 ${variantPreview.internalEdges.length} 条内部连线，跳过 ${variantPreview.droppedEdges.length} 条边界或无效连线。`, `Copy ${variantPreview.nodes.length} nodes and ${variantPreview.internalEdges.length} internal links; omit ${variantPreview.droppedEdges.length} boundary or invalid links.`)}</p>
        <ul>{variantPreview.nodes.map(node => <li key={node.id}><strong>{node.title || t(nodeLabels[node.kind][0], nodeLabels[node.kind][1])}</strong><small>{t(nodeLabels[node.kind][0], nodeLabels[node.kind][1])}</small>{node.prompt && <p>{node.prompt}</p>}{node.reference && <p>{node.reference.name} · {t('素材版本', 'Asset version')} {node.reference.version}</p>}{node.settings && <p>{Object.entries(node.settings).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>}{node.jobId && <small>{t('副本从未执行状态开始', 'The copy starts without a run')}</small>}</li>)}</ul>
        {variantPreview.internalEdges.length > 0 && <ul aria-label={t('将复制的连线', 'Links to copy')}>{variantPreview.internalEdges.map(edge => <li key={edge.id}>{variantPreview.nodes.find(node => node.id === edge.from)?.title} → {variantPreview.nodes.find(node => node.id === edge.to)?.title} · {t(roleLabels[edge.role][0], roleLabels[edge.role][1])}</li>)}</ul>}
        <p className="nc-help">{t('副本向右下方偏移；保留提示词、参数和素材版本。确认只复制方案，需要你另行开始生成。', 'Copies move down and right and retain prompts, settings and asset versions. Confirmation copies the plan; generation requires a separate action.')}</p>
        {doc && (conflict || variantSourceKey(doc) !== variantReview.key) && <p role="alert">{t('画布已变化，请关闭后重新预览。', 'The canvas changed. Close this preview and review again.')}</p>}
        {doc && doc.nodes.length + variantPreview.nodes.length > 80 && <p role="alert">{t('复制后将超过 80 个节点，无法添加这份变体。', 'This copy would exceed the 80-node limit.')}</p>}
        <div className="nw-dialog-actions"><button className="nw-button" onClick={closeVariant}>{t('取消', 'Cancel')}</button><button className="nw-button nw-button-primary" disabled={locked || !!busy || !doc || variantSourceKey(doc) !== variantReview.key || doc.nodes.length + variantPreview.nodes.length > 80 || !variantPreview.nodes.length} onClick={confirmVariant}>{t('确认复制变体', 'Confirm variant copy')}</button></div>
      </div>
    </Modal>}
    {libraryOpen && <Modal title={t('添加参考素材', 'Add references')} close={() => setLibraryOpen(false)}><div className="nc-library"><div className="nc-input-row"><input placeholder={t('搜索资料库图片', 'Search library images')} aria-label={t('搜索参考图', 'Search references')} value={query} onChange={e => setQuery(e.target.value)} /><button className="nw-button" onClick={() => { setLibraryOpen(false); fileInput.current?.click(); }}><Plus size={15} />{t('上传', 'Upload')}</button></div>{library.filter(e => e.name.toLowerCase().includes(query.toLowerCase())).slice(0, 100).map(e => <button key={e.id} className="nc-library-item" onClick={() => { addNode('asset', { id: e.id, version: e.sha256, name: e.name }); setLibraryOpen(false); }}><ImageIcon size={18} /><span>{e.name}<small>{e.path}</small></span><Plus size={15} /></button>)}{!library.length && <p className="nc-help">{t('资料库还没有图片，可上传一张开始。', 'Upload an image to get started.')}</p>}</div></Modal>}
  </section>;
}
