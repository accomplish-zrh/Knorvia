"use client";

/**
 * MemoryView — route C night-shift P0 (C03/C07/C08/C09/C10 slice).
 *
 * Minimal closed loop over the `memory/*` control-plane RPC: a timeline of
 * real revisions, a relation graph derived only from real records, a
 * recall search that shows why something came back, and an evidence panel
 * for the selected record. Empty states are honest; forgotten/merged
 * records appear only when explicitly included; every mutation goes
 * through the audited RPC (revision-checked).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eraser,
  Eye,
  History,
  Loader2,
  Network,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  ShieldCheck,
  Share2,
  Brain,
  Download,
  Upload,
  Maximize2,
  ZoomIn,
  ZoomOut,
  ChevronRight,
  ScanSearch,
  X,
} from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { MemoryDuplicatesPanel } from "./MemoryDuplicatesPanel";
import { memoryGraphLayout, memoryGraphPreview } from "@/lib/native-memory-graph";
import type { MemoryRecord, MemoryRevisionEvent, RecallTrace } from "./memory-types";
import type { NativeBotProfile, NativeRoom } from "@/lib/knorvia-native-types";
import "./memory.css";

type GraphPayload = {
  nodes: Array<{ id: string; kind: string; contentPreview: string; pinned: boolean; useCount: number; status: string; updatedAtMs: number }>;
  edges: Array<{ fromId: string; toId: string; relationType: string; inferred: boolean }>;
  truncated: boolean;
};

const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  create: { zh: "创建", en: "Created" },
  update: { zh: "修改", en: "Updated" },
  forget: { zh: "遗忘", en: "Forgotten" },
  restore: { zh: "恢复", en: "Restored" },
  merge: { zh: "合并", en: "Merged" },
  share: { zh: "共享调整", en: "Sharing changed" },
  pin: { zh: "固定切换", en: "Pin changed" },
  import: { zh: "导入", en: "Imported" },
};

const KIND_STYLES: Record<string, string> = {
  fact: "nw-mem-chip-kind-fact",
  preference: "nw-mem-chip-kind-preference",
  event: "nw-mem-chip-kind-event",
  relation: "nw-mem-chip-kind-relation",
  note: "nw-mem-chip-kind-note",
};
const KIND_LABELS: Record<string, [string, string]> = { fact: ["事实", "Fact"], preference: ["偏好", "Preference"], event: ["事件", "Event"], relation: ["关系", "Relation"], note: ["笔记", "Note"] };
const RELATION_LABELS: Record<string, [string, string]> = { supports: ["支持", "Supports"], contradicts: ["矛盾", "Contradicts"], relates_to: ["关联", "Related"], refines: ["补充", "Refines"], derived_from: ["源于", "Derived from"] };

function fmtTime(ms: number, utc: boolean) {
  const date = new Date(ms);
  return utc ? date.toUTCString() : date.toLocaleString();
}

export function MemoryView() {
  const { request, t, connection, workspaces, setNotice, theme } = useWorkbench();
  const [tab, setTab] = useState<"timeline" | "graph" | "search" | "tidy">("graph");
  const [bots, setBots] = useState<NativeBotProfile[]>([]);
  const [rooms, setRooms] = useState<NativeRoom[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [botId, setBotId] = useState("");
  const [editContent, setEditContent] = useState("");
  const [shareConversation, setShareConversation] = useState("");
  const [graphError, setGraphError] = useState(false);
  const [graphLimit, setGraphLimit] = useState(300);
  const [conversation, setConversation] = useState("");
  const [includeForgotten, setIncludeForgotten] = useState(false);
  const [utc, setUtc] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState<MemoryRevisionEvent[]>([]);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<MemoryRevisionEvent[]>([]);
  const [query, setQuery] = useState("");
  const [trace, setTrace] = useState<RecallTrace | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [statusById, setStatusById] = useState<Map<string, MemoryRecord>>(new Map());
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const graphHost = useRef<HTMLDivElement | null>(null);
  const graphInstance = useRef<import("cytoscape").Core | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const evidenceHeading = useRef<HTMLHeadingElement>(null);
  const detailOrigin = useRef<{ element: HTMLElement | null; recordId: string } | null>(null);
  const focusEvidence = useRef(false);
  const kindLabel = (kind: string) => KIND_LABELS[kind] ? t(...KIND_LABELS[kind]) : kind;
  const relationLabel = (kind: string) => RELATION_LABELS[kind] ? t(...RELATION_LABELS[kind]) : kind;

  useEffect(() => {
    if (connection !== "connected") return;
    let active = true;
    void Promise.all([request<NativeBotProfile[]>("bot/list", {}), request<NativeRoom[]>("room/list", {})]).then(([nextBots, nextRooms]) => {
      if (active) { setBots(nextBots); setRooms(nextRooms); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [connection, request]);

  const scope = useMemo(
    () => ({
      owner: "local",
      workspace: workspaceId || "*",
      bot: botId || "*",
      conversation: conversation || "*",
    }),
    [workspaceId, botId, conversation],
  );

  const load = useCallback(async () => {
    if (connection !== "connected") return;
    const current = ++generation.current;
    selectionGeneration.current += 1;
    setLoading(true);
    setError("");
    try {
      const timelineValue = await request<{ events: MemoryRevisionEvent[] }>("memory/timeline", {
        scope,
        includeForgotten,
      });
      const graphValue = await request<GraphPayload>("memory/graph", { scope, includeForgotten, limit: graphLimit });
      const listValue = await request<{ records: MemoryRecord[] }>("memory/list", {
        scope,
        includeStatuses: ["active", "forgotten", "merged"],
        limit: 200,
      });
      if (current !== generation.current) return;
      setTimeline(timelineValue.events ?? []);
      setGraph(graphValue);
      setRecords(listValue.records ?? []);
      setStatusById(new Map((listValue.records ?? []).map(record => [record.id, record])));
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [connection, request, scope, includeForgotten, graphLimit]);

  useEffect(() => {
    setSelected(null); setSelectedHistory([]); setTrace(null); setRecords([]);
    setTimeline([]); setGraph(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const openRecord = useCallback(
    async (id: string) => {
      const active = document.activeElement;
      if (!inspectorRef.current?.querySelector('.nw-mem-evidence')?.contains(active)) {
        detailOrigin.current = { element: active instanceof HTMLElement && active !== document.body ? active : graphHost.current, recordId: id };
      }
      const current = generation.current;
      const selectionRequest = ++selectionGeneration.current;
      setSelectedHistory([]);
      try {
        const value = await request<{ record: MemoryRecord | null }>("memory/get", { id, scope });
        if (current !== generation.current || selectionRequest !== selectionGeneration.current) return;
        if (value.record) {
          focusEvidence.current = true;
          setSelected(value.record);
          setEditContent(value.record.content);
          const history = await request<{ events: MemoryRevisionEvent[] }>("memory/timeline", {
            scope,
            recordId: id,
          });
          if (current === generation.current && selectionRequest === selectionGeneration.current) setSelectedHistory(history.events ?? []);
        }
      } catch (cause) {
        if (current === generation.current) setError(errorText(cause));
      }
    },
    [request, scope],
  );

  useEffect(() => {
    if (!selected || !focusEvidence.current) return;
    focusEvidence.current = false;
    if (!window.matchMedia('(max-width: 1000px)').matches) return;
    const frame = requestAnimationFrame(() => {
      evidenceHeading.current?.focus({ preventScroll: true });
      inspectorRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const closeEvidence = () => {
    selectionGeneration.current += 1;
    setSelected(null);
    const origin = detailOrigin.current;
    requestAnimationFrame(() => {
      const target = origin?.element?.isConnected ? origin.element : origin ? inspectorRef.current?.querySelector<HTMLElement>(`[data-memory-id="${CSS.escape(origin.recordId)}"]`) : null;
      target?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 1000px)').matches) target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  };

  const act = useCallback(
    async (id: string, revision: number, method: string, params: Record<string, unknown>) => {
      const current = generation.current;
      setBusyId(id);
      setError("");
      try {
        await request(method, { id, scope, expectedRevision: revision, ...params });
        if (current !== generation.current) return;
        setSelected(null);
        await load();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setBusyId(null);
      }
    },
    [request, load, scope],
  );

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await request<{ results: Array<{ record: MemoryRecord; score: number; matchedTerms: string[] }>; trace: RecallTrace }>(
        "memory/search",
        { query, scope, limit: 20 },
      );
      if (current !== generation.current) return;
      setTrace(value.trace ?? null);
      setRecords(value.results.map(hit => hit.record));
      if (tab !== "search") setTab("search");
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [query, scope, request, tab]);

  // Graph rendering: deterministic layout, list fallback always available.
  useEffect(() => {
    if (tab !== "graph" || !graph || !graphHost.current) return;
    setGraphError(false);
    let destroyed = false;
    let instance: import("cytoscape").Core | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    void (async () => {
      try {
        const cytoscape = (await import("cytoscape")).default;
        if (destroyed || !graphHost.current) return;
        instance = cytoscape({
          container: graphHost.current,
          elements: [
            ...graph.nodes.map(node => ({ data: { id: node.id, label: `${KIND_LABELS[node.kind] ? t(...KIND_LABELS[node.kind]) : node.kind}\n${memoryGraphPreview(node.contentPreview)}`, kind: node.kind } })),
            ...graph.edges.map((edge, index) => ({
              data: { id: `e${index}`, source: edge.fromId, target: edge.toId, label: RELATION_LABELS[edge.relationType] ? t(...RELATION_LABELS[edge.relationType]) : edge.relationType, inferred: edge.inferred },
            })),
          ],
          layout: memoryGraphLayout(graph.nodes.map(node => node.id), graph.edges),
          minZoom: 0.04, maxZoom: 1.6,
          style: [
            { selector: "node", style: { label: "data(label)", "font-size": 14, "font-family": "system-ui, sans-serif", "line-height": 1.5, shape: "round-rectangle", "background-color": getComputedStyle(graphHost.current).getPropertyValue("--nw-bg").trim() || "#fff", "border-width": 1, "border-color": getComputedStyle(graphHost.current).getPropertyValue("--nw-line").trim() || "#ddd", color: getComputedStyle(graphHost.current).getPropertyValue("--nw-ink").trim() || "#333", "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": 214, width: 240, height: 125, padding: 10 } },
            { selector: 'node[kind="preference"]', style: { "border-color": "#9b83c8", "border-width": 2 } },
            { selector: 'node[kind="fact"]', style: { "border-color": "#6c96b8", "border-width": 2 } },
            { selector: 'node[kind="event"]', style: { "border-color": "#bd975f", "border-width": 2 } },
            { selector: "node:selected", style: { "border-width": 3, "border-color": getComputedStyle(graphHost.current).getPropertyValue("--nw-ink").trim() || "#333" } },
            { selector: "edge", style: { label: "data(label)", "font-size": 11, "text-background-opacity": 1, "text-background-color": getComputedStyle(graphHost.current).getPropertyValue("--nw-bg").trim() || "#fff", "text-background-padding": 4, color: getComputedStyle(graphHost.current).getPropertyValue("--nw-muted").trim() || "#888", width: 1.5, "line-color": "#a3aab5", "target-arrow-color": "#a3aab5", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
            { selector: "edge[?inferred]", style: { "line-style": "dashed" } },
          ] as never,
        });
        instance!.on("tap", "node", (event: { target: { id: () => string } }) => {
          void openRecord(event.target.id());
        });
        graphInstance.current = instance;
        instance.resize();
        instance.fit(undefined, 38);
        // Nodes use 14px labels. Keep the initial view at >=12 rendered px
        // instead of shrinking every card to a thumbnail to fit the whole graph.
        const readableZoom = 12 / 14;
        if (instance.zoom() < readableZoom && instance.nodes().length) {
          instance.zoom(readableZoom);
          instance.center(instance.nodes().first());
        } else if (instance.zoom() > 1) {
          instance.zoom(1);
          instance.center();
        }
        let canvasWidth = instance.width(), canvasHeight = instance.height();
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            if (destroyed || !instance) return;
            // Resizing must preserve the user's pan/zoom, including a deliberate
            // full-graph overview requested with the Fit button.
            const pan = instance.pan();
            instance.resize();
            const nextWidth = instance.width(), nextHeight = instance.height();
            instance.pan({ x: pan.x + (nextWidth - canvasWidth) / 2, y: pan.y + (nextHeight - canvasHeight) / 2 });
            canvasWidth = nextWidth;
            canvasHeight = nextHeight;
          });
        });
        resizeObserver.observe(graphHost.current);
      } catch {
        if (!destroyed) setGraphError(true);
        // Import or render failure degrades to the list view below.
      }
    })();
    return () => {
      destroyed = true;
      resizeObserver?.disconnect();
      cancelAnimationFrame(resizeFrame);
      instance?.destroy();
      graphInstance.current = null;
      instance = null;
    };
  }, [tab, graph, openRecord, theme, t]);

  // Timeline cards reflect the record's CURRENT status, not the historical
  // snapshot embedded in each event: a record forgotten after its create
  // event must show restore actions, not stale forget buttons.
  const visibleTimeline = useMemo(() => {
    const statusOf = (event: MemoryRevisionEvent) => event.currentStatus ?? statusById.get(event.record.id)?.status ?? event.record.status;
    return includeForgotten
      ? timeline
      : timeline.filter(event => statusOf(event) === "active");
  }, [timeline, statusById, includeForgotten]);

  const nodeCount = graph?.nodes.length ?? 0;
  const roomName = (id: string) => rooms.find(room => room.id === id)?.title ?? (id === "*" ? t("全部会话", "All conversations") : id);
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? (id === "*" ? t("全部 Bot", "All bots") : id);
  const workspaceName = (id: string) => workspaces.find(workspace => workspace.id === id)?.title ?? (id === "*" ? t("全部项目", "All projects") : id);
  const fitGraph = () => { const instance = graphInstance.current; if (!instance) return; instance.fit(undefined, 38); if (instance.zoom() > 1) { instance.zoom(1); instance.center(); } };
  const zoomGraph = (factor: number) => { const instance = graphInstance.current; if (instance) instance.zoom({ level: Math.max(0.04, Math.min(1.6, instance.zoom() * factor)), renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 } }); };
  const chip = (kind: string) => <span className={`nw-mem-chip ${KIND_STYLES[kind] ?? ""}`}>{kindLabel(kind)}</span>;
  const selectedTrace = trace?.hits.find(hit => hit.recordId === selected?.id);

  return <div className="nw-memory-view">
    <header className="nw-memory-header">
      <div><span className="nw-memory-eyebrow"><Brain size={15} />{t("你的个人记忆", "Your personal memory")}</span><h1>{t("记住重要的事", "Keep what matters")}</h1><p>{t("查看记忆之间的联系，追溯来源，随时修订。", "Explore connections, trace their sources, and make changes anytime.")}</p></div>
      <div className="nw-memory-file-actions">
        <button className="nw-button" disabled={loading || connection !== "connected"} onClick={() => void (async () => {
          try {
            const bundle = await request<Record<string, unknown>>("memory/export", { scope });
            const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
            const anchor = document.createElement("a"); anchor.href = url; anchor.download = `knorvia-memory-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (cause) { setError(errorText(cause)); }
        })()}><Download size={15} />{t("导出", "Export")}</button>
        <label className="nw-button"><Upload size={15} />{t("导入", "Import")}<input type="file" accept="application/json" className="nw-visually-hidden" onChange={event => void (async () => {
          const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
          try { const bundle = JSON.parse(await file.text()); const value = await request<{ created: number; applied: number; kept: number }>("memory/import", { bundle }); setNotice(t(`导入完成：新建 ${value.created}、应用 ${value.applied}、保留 ${value.kept}`, `Imported: ${value.created} new, ${value.applied} applied, ${value.kept} kept`)); await load(); }
          catch (cause) { setError(errorText(cause)); }
        })()} /></label>
      </div>
    </header>
    <div className="nw-memory-scope">
      <label><span>{t("项目", "Project")}</span><select aria-label={t("项目范围", "Workspace scope")} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">{t("全部项目", "All projects")}</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
      <label><span>Bot</span><select aria-label={t("Bot 范围", "Bot scope")} value={botId} onChange={event => setBotId(event.target.value)}><option value="">{t("全部 Bot", "All bots")}</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label><span>{t("会话", "Conversation")}</span><select aria-label={t("会话范围（空=全部）", "Conversation scope (blank = all)")} value={conversation} onChange={event => setConversation(event.target.value)}><option value="">{t("全部会话", "All conversations")}</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.title}{room.kind === "dm" ? t(" · 私聊", " · Direct") : t(" · 群聊", " · Group")}</option>)}</select></label>
      <label className="nw-memory-forgotten"><input type="checkbox" checked={includeForgotten} onChange={event => setIncludeForgotten(event.target.checked)} />{t("包含已遗忘", "Include forgotten")}</label>
    </div>
    <div className="nw-memory-viewbar">
      <div className="nw-memory-tabs" role="group" aria-label={t("记忆视图", "Memory views")}>{([["graph", Network, "关系图", "Connections"], ["timeline", History, "时间线", "Timeline"], ["search", Search, "检索", "Search"], ["tidy", ScanSearch, "整理", "Tidy"]] as const).map(([id, Icon, zh, en]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={15} />{t(zh, en)}</button>)}</div>
      <span className="nw-memory-count">{loading ? <Loader2 size={14} className="nw-spin" aria-label={t("加载中", "Loading")} /> : <><strong>{nodeCount}{graph?.truncated ? "+" : ""}</strong> {t("条记忆", "memories")}<i />{graph?.edges.length ?? 0} {t("个联系", "connections")}</>}</span>
    </div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    <div className="nw-memory-body">
      <div className="nw-memory-primary">
        {tab === "graph" && <section className="nw-memory-map" aria-label={t("记忆关系图", "Memory relation graph")}>
          <div className="nw-memory-map-top"><span><Network size={15} />{t("记忆之间的联系", "How memories connect")}</span><div><button aria-label={t("缩小关系图", "Zoom out")} onClick={() => zoomGraph(0.8)}><ZoomOut size={16} /></button><button aria-label={t("放大关系图", "Zoom in")} onClick={() => zoomGraph(1.25)}><ZoomIn size={16} /></button><button aria-label={t("适应画布", "Fit graph")} title={t("查看完整关系图", "Show the whole graph")} onClick={fitGraph}><Maximize2 size={15} /></button></div></div>
          {graphError && <p className="nw-help" role="status">{t("关系图暂时无法绘制，请从右侧条目打开记忆。", "The graph could not render. Open a memory from the list.")}</p>}
          {nodeCount > 0 ? <div key="graph-canvas" className={`nw-mem-graph${nodeCount <= 5 ? " is-compact" : ""}`} ref={graphHost} tabIndex={-1} aria-label={t("关系图画布", "Graph canvas")} /> : <div key="graph-empty" className="nw-memory-empty"><Brain size={32} /><h2>{t("这里还没有记忆", "No memories here yet")}</h2><p>{t("切换项目或会话，查看已有内容。", "Choose another project or conversation to explore existing memories.")}</p></div>}
          <footer className="nw-memory-map-foot"><span>{t("拖动浏览 · 滚轮缩放 · 点击节点查看详情", "Drag to explore · Scroll to zoom · Select a node for details")}</span><label>{t("显示上限", "Limit")} <select aria-label={t("图谱节点上限", "Graph node limit")} value={graphLimit} onChange={event => setGraphLimit(Number(event.target.value))}><option value={100}>100</option><option value={300}>300</option><option value={1000}>1000</option></select></label></footer>
          {graph?.truncated && <p className="nw-help">{t("当前显示一部分记忆，可调整范围或提高显示上限。", "Some memories are outside this view. Narrow the scope or raise the limit.")}</p>}
          {!!graph?.edges.length && <div className="nw-memory-connections"><h3>{t("关系明细", "Connections")}</h3>{graph.edges.slice(0, 8).map((edge, index) => <div key={`${edge.fromId}-${index}`}><button onClick={() => void openRecord(edge.fromId)}>{graph.nodes.find(node => node.id === edge.fromId)?.contentPreview.slice(0, 36) ?? edge.fromId}</button><span className={edge.inferred ? "is-inferred" : ""}>{relationLabel(edge.relationType)}{edge.inferred ? t(" · 推断", " · Inferred") : ""}<ChevronRight size={12} /></span><button onClick={() => void openRecord(edge.toId)}>{graph.nodes.find(node => node.id === edge.toId)?.contentPreview.slice(0, 36) ?? edge.toId}</button></div>)}</div>}
        </section>}
        {tab === "timeline" && <section className="nw-mem-list" aria-label={t("记忆时间线", "Memory timeline")}>
          <div className="nw-memory-list-heading"><h2>{t("修改与使用轨迹", "Memory history")}</h2><button className="nw-button nw-button-small" aria-pressed={utc} onClick={() => setUtc(value => !value)}>{utc ? "UTC" : t("本地时间", "Local time")}</button></div>
          {!visibleTimeline.length && !loading && <p className="nw-memory-empty">{t("当前范围还没有记忆记录。", "No memory records in this scope yet.")}</p>}
          {visibleTimeline.map((event, index) => {
            const label = ACTION_LABELS[event.action] ?? { zh: event.action, en: event.action };
            const current = statusById.get(event.record.id); const status = event.currentStatus ?? current?.status ?? event.record.status; const revision = event.currentRevision ?? current?.revision ?? event.record.revision; const pinned = event.currentPinned ?? current?.pinned ?? event.record.pinned;
            return <article key={`${event.record.id}-${event.record.revision}-${index}`} className={`nw-mem-card nw-memory-event${status !== "active" ? " is-inactive" : ""}`}><header>{chip(event.record.kind)}<strong>{t(label.zh, label.en)}</strong><time>{fmtTime(event.atMs, utc)}</time></header><p>{event.record.content}</p><footer><button className="nw-button nw-button-small" onClick={() => void openRecord(event.record.id)}><Eye size={14} />{t("证据与历史", "Evidence & history")}</button>{status === "active" && <><button className="nw-button nw-button-small" disabled={busyId === event.record.id} onClick={() => void act(event.record.id, revision, "memory/pin", { pinned: !pinned })}>{pinned ? <PinOff size={13} /> : <Pin size={13} />}{pinned ? t("取消固定", "Unpin") : t("固定", "Pin")}</button><button className="nw-button nw-button-small" disabled={busyId === event.record.id} onClick={() => void act(event.record.id, revision, "memory/forget", {})}><Eraser size={13} />{t("遗忘", "Forget")}</button></>}{status === "forgotten" && <button className="nw-button nw-button-small" disabled={busyId === event.record.id} onClick={() => void act(event.record.id, revision, "memory/restore", {})}><RotateCcw size={13} />{t("恢复", "Restore")}</button>}</footer></article>;
          })}
        </section>}
        {tab === "tidy" && <MemoryDuplicatesPanel key={JSON.stringify(scope)} scope={scope} onChanged={() => void load()} />}
        {tab === "search" && <section className="nw-mem-list" aria-label={t("检索结果", "Search results")}>
          <form className="nw-memory-search" onSubmit={event => { event.preventDefault(); void runSearch(); }}><Search size={18} /><input aria-label={t("检索记忆", "Search memory")} placeholder={t("回忆一件事，输入关键词…", "Find a memory by keyword…")} value={query} maxLength={512} onChange={event => setQuery(event.target.value)} /><button className="nw-button" disabled={!query.trim() || loading || connection !== "connected"}>{t("检索", "Search")}</button></form>
          {!trace ? <p className="nw-help">{t("只检索当前范围内的记忆。", "Search stays within the selected scope.")}</p> : <p className="nw-help">{t(`找到 ${trace.hits.length} 条相关记忆，选择一条查看召回依据。`, `${trace.hits.length} related memories. Select one to inspect its recall evidence.`)}</p>}
          {trace && records.map(record => <article key={record.id} className="nw-mem-card nw-memory-event"><header>{chip(record.kind)}<time>{fmtTime(record.createdAtMs, utc)}</time></header><p>{record.content}</p><footer><button className="nw-button nw-button-small" onClick={() => void openRecord(record.id)}><Eye size={14} />{t("为什么想起它", "Why recalled")}</button><span>{t(`被使用 ${record.useCount} 次`, `Used ${record.useCount} times`)}</span></footer></article>)}
        </section>}
      </div>
      <aside className="nw-memory-inspector" ref={inspectorRef}>
        {selected ? <section className="nw-mem-evidence" aria-label={t("证据面板", "Evidence panel")}>
          <header><div>{chip(selected.kind)}<h2 ref={evidenceHeading} tabIndex={-1}>{t("这条记忆", "This memory")}</h2></div><button className="nw-icon" aria-label={t("关闭详情并返回条目", "Close details and return to memory")} onClick={closeEvidence}><X size={17} /></button></header>
          <p className="nw-memory-selected-content">{selected.content}</p><div className="nw-memory-detail-stats"><span><History size={13} />{t(`修订 ${selected.revision}`, `Revision ${selected.revision}`)}</span><span>{t(`使用 ${selected.useCount} 次`, `Used ${selected.useCount} times`)}</span></div>
          <dl><dt>{t("所属范围", "Scope")}</dt><dd>{workspaceName(selected.scope.workspace)} · {botName(selected.scope.bot)} · {roomName(selected.scope.conversation)}</dd><dt>{t("来源", "Sources")}</dt><dd>{selected.sourceRefs.length ? selected.sourceRefs.map((source, index) => <span className="nw-memory-source" key={`${source.id}-${index}`}>{source.note || source.kind}<code>{source.id}</code></span>) : t("这条记录没有附带来源引用。", "No source reference was attached to this record.")}</dd>{selected.relation && <><dt>{t("关系", "Relation")}</dt><dd>{relationLabel(selected.relation.relationType)}{selected.relation.inferred ? t(" · 推断，未证实", " · Inferred, unverified") : ""}<button className="nw-memory-related-link" onClick={() => void openRecord(selected.relation!.targetId)}>{graph?.nodes.find(node => node.id === selected.relation!.targetId)?.contentPreview || selected.relation.targetId}<ChevronRight size={13} /></button></dd></>}{!!selected.sharedScopes?.length && <><dt>{t("已共享到", "Shared with")}</dt><dd>{selected.sharedScopes.map(share => roomName(share.conversation)).join("、")}</dd></>}</dl>
          {selectedTrace && <details className="nw-memory-detail-section" open><summary>{t("为什么想起它", "Why it was recalled")}</summary><p>{t(`匹配词：${selectedTrace.matchedTerms.join("、") || "—"}`, `Matched: ${selectedTrace.matchedTerms.join(", ") || "—"}`)}</p><ul>{selectedTrace.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><small>{trace?.id}</small></details>}
          {selected.status === "active" && <details className="nw-memory-detail-section" open><summary>{t("编辑与共享", "Edit and share")}</summary><div className="nw-mem-editor"><label htmlFor="nw-memory-edit">{t("编辑记忆", "Edit memory")}</label><textarea id="nw-memory-edit" rows={4} value={editContent} maxLength={32768} onChange={event => setEditContent(event.target.value)} /><button className="nw-button" disabled={busyId === selected.id || !editContent.trim() || editContent === selected.content} onClick={() => void act(selected.id, selected.revision, "memory/update", { content: editContent })}>{t("保存修订", "Save revision")}</button><label htmlFor="nw-memory-share">{t("显式共享到会话", "Share with a conversation")}</label><select id="nw-memory-share" value={shareConversation} onChange={event => setShareConversation(event.target.value)}><option value="">{t("选择目标会话", "Choose a conversation")}</option>{rooms.filter(room => room.id !== selected.scope.conversation).map(room => <option key={room.id} value={room.id}>{room.title}</option>)}</select><button className="nw-button" disabled={busyId === selected.id || !shareConversation || shareConversation.includes("*")} onClick={() => void act(selected.id, selected.revision, "memory/share", { addScopes: [{ ...selected.scope, conversation: shareConversation }] }).then(() => setShareConversation(""))}><Share2 size={14} />{t("共享此记忆", "Share this memory")}</button>{!!selected.sharedScopes?.length && <button className="nw-button" disabled={busyId === selected.id} onClick={() => void act(selected.id, selected.revision, "memory/share", { removeScopes: selected.sharedScopes })}><ShieldCheck size={14} />{t("撤销全部共享", "Revoke all sharing")}</button>}</div></details>}
          <details className="nw-memory-detail-section"><summary>{t(`修改轨迹 · ${selectedHistory.length}`, `Revision history · ${selectedHistory.length}`)}</summary><ol className="nw-mem-history">{selectedHistory.map((event, index) => { const label = ACTION_LABELS[event.action] ?? { zh: event.action, en: event.action }; return <li key={index}><strong>{t(label.zh, label.en)}</strong><time>{fmtTime(event.atMs, utc)} · v{event.record.revision}</time><p>{event.record.content}</p></li>; })}</ol></details>
          {selected.status === "active" && <details className="nw-memory-detail-section"><summary>{t("整理重复记录", "Merge duplicate memories")}</summary><div className="nw-mem-editor"><input aria-label={t("合并目标记录 ID", "Merge target record id")} value={mergeTarget} maxLength={64} onChange={event => setMergeTarget(event.target.value)} placeholder={t("目标记录 ID", "Target record ID")} /><button className="nw-button" disabled={busyId === selected.id || !mergeTarget.trim()} onClick={() => void act(selected.id, selected.revision, "memory/merge", { sourceId: selected.id, targetId: mergeTarget.trim() }).then(() => setMergeTarget(""))}>{t("合并进该记录", "Merge into it")}</button></div></details>}
        </section> : <section className="nw-memory-records"><header><h2>{t("记忆条目", "Memories")}</h2><span>{nodeCount}</span></header><p>{t("选择卡片，查看来源和修改轨迹。", "Select a card to see its sources and history.")}</p><div className="nw-memory-record-list">{graph?.nodes.map(node => <button key={node.id} className="nw-memory-record" data-memory-id={node.id} onClick={() => void openRecord(node.id)}>{chip(node.kind)}<span>{node.contentPreview || t("空内容", "Empty content")}</span><small>{node.pinned && <Pin size={12} />}{t(`使用 ${node.useCount} 次`, `Used ${node.useCount} times`)}<ChevronRight size={13} /></small></button>)}</div></section>}
      </aside>
    </div>
    <p className="nw-memory-privacy"><ShieldCheck size={14} />{t("记忆按项目、Bot 与会话隔离。只有明确共享的内容才会进入其他会话。", "Memories stay within their project, bot, and conversation unless explicitly shared.")}</p>
  </div>;
}
