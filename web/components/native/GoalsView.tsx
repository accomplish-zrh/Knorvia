"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GoalAcceptanceDialog } from "./GoalAcceptanceDialog";
import { Check, Loader2, Plus, Search, Target } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";
import { GoalCard } from "./GoalCard";
import { GOALS_RENDER_LIMIT, filterGoals, GoalBrowser, type GoalBrowserState, type GoalScope } from "@/lib/native-goal-browser";
import type { NativeGoal, NativeGoalExecution } from "@/lib/knorvia-native-types";

export function GoalEditor({ goal, close, saved }: { goal?: NativeGoal; close: () => void; saved: () => Promise<void> }) {
  const { t, request, workspaceId } = useWorkbench();
  const [title, setTitle] = useState(goal?.title ?? "");
  const [criteria, setCriteria] = useState(goal?.successCriteria ?? "");
  const [constraints, setConstraints] = useState(goal?.constraints ?? "");
  const [nextAction, setNextAction] = useState(goal?.nextAction ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <Modal title={goal ? t("编辑目标", "Edit goal") : t("新建目标", "New goal")} close={close}><form onSubmit={async event => {
    event.preventDefault(); if (pending || !title.trim() || !workspaceId) return;
    setPending(true); setError("");
    try {
      await request(goal ? "goal/update" : "goal/create", goal
        ? { id: goal.id, revision: goal.revision, title: title.trim(), successCriteria: criteria.trim(), constraints: constraints.trim(), nextAction: nextAction.trim() }
        : { workspaceId, title: title.trim(), successCriteria: criteria.trim(), constraints: constraints.trim(), nextAction: nextAction.trim() });
      await saved(); close();
    } catch (caught) { setError(errorText(caught)); } finally { setPending(false); }
  }}><label className="nw-field">{t("目标", "Goal")}<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("例如：把毕业论文初稿写完", "e.g. Finish the thesis draft")} /></label><label className="nw-field">{t("怎样算完成", "What does done look like?")}<textarea required={!goal} rows={3} maxLength={4000} value={criteria} onChange={event => setCriteria(event.target.value)} placeholder={goal ? t("留空则保持原有判据。", "Leave empty to keep the current criteria.") : t("写清楚可核对的条件，完成后才允许标记。", "State checkable conditions. Completion can only be marked once these exist.")} /></label><label className="nw-field">{t("约束（可选）", "Constraints (optional)")}<textarea rows={2} maxLength={4000} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder={t("范围、期限、预算或安全边界。", "Scope, deadlines, budget, or safety boundaries.")} /></label><label className="nw-field">{t("下一动作（可选）", "Next action (optional)")}<input maxLength={500} value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder={t("继续推进时的第一步。", "The first step when work resumes.")} /></label><p className="nw-help">{t("目标跨任务与重启保留进度；已完成的目标保持记录，不能重新打开。", "Goals keep their progress across tasks and restarts. Completed goals stay on the record and cannot be reopened.")}</p>{error && <p className="nw-inline-error" role="alert">{error}</p>}<div className="nw-dialog-actions"><button type="button" className="nw-button" onClick={close}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={pending || !title.trim() || (!goal && !criteria.trim())}>{pending ? <Loader2 className="nw-spin" size={14} /> : <Check size={14} />}{goal ? t("保存", "Save") : t("创建目标", "Create goal")}</button></div></form></Modal>;
}

export function GoalsView() {
  const router = useRouter();
  const [acceptance, setAcceptance] = useState<NativeGoal>();
  const { t, locale, connection, request, workspaceId, workspaces, refresh } = useWorkbench();
  const [summaries, setSummaries] = useState<Record<string, NativeGoalExecution | undefined>>({});
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ goal?: NativeGoal }>();
  const [pending, setPending] = useState("");
  const [filter, setFilter] = useState("ongoing");
  // B14: page-local scope and search. The page's project filter never changes
  // which project a NEW goal is created in — the editor still uses the global
  // workspace selection.
  const [scope, setScope] = useState<GoalScope>("all");
  const [scopeProjectId, setScopeProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [renderLimit, setRenderLimit] = useState(GOALS_RENDER_LIMIT);
  const requestRef = useRef(request); requestRef.current = request;
  const goalBrowser = useRef<GoalBrowser | null>(null);
  if (!goalBrowser.current) goalBrowser.current = new GoalBrowser(workspace => requestRef.current<{ goals: NativeGoal[] }>("goal/list", { workspaceId: workspace }));
  const [browserState, setBrowserState] = useState<GoalBrowserState>({ goals: [], failures: [], loading: true });
  useEffect(() => { const unsubscribe = goalBrowser.current!.subscribe(() => setBrowserState(goalBrowser.current!.getSnapshot())); return () => { unsubscribe(); goalBrowser.current!.cancel(); }; }, []);
  useEffect(() => { if (!scopeProjectId && workspaceId) setScopeProjectId(workspaceId); }, [workspaceId, scopeProjectId]);
  const missingProject = scope === "single" && !workspaces.some(project => project.id === scopeProjectId);
  const targetKey = JSON.stringify(scope === "single" ? missingProject ? [] : [scopeProjectId] : workspaces.map(project => project.id).sort());
  const targets = useMemo<string[]>(() => JSON.parse(targetKey), [targetKey]);
  useEffect(() => setRenderLimit(GOALS_RENDER_LIMIT), [targetKey, search, filter]);
  const load = useCallback(async () => {
    await goalBrowser.current!.load(targets, true);
  }, [targets]);
  useEffect(() => {
    if (connection !== "connected") { goalBrowser.current!.cancel(); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        await goalBrowser.current!.load(targets);
        if (!cancelled) setError("");
      } catch (caught) { if (!cancelled) setError(errorText(caught)); }
    };
    void poll();
    // Goals change from other clients and from scheduled work; the browser is
    // single-flight, so overlapping ticks share the current read.
    const timer = setInterval(() => { if (!document.hidden) void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); goalBrowser.current!.cancel(); };
  }, [targets, connection]);
  const loadSummary = async (goal: NativeGoal) => {
    try {
      const read = await request<{ execution?: NativeGoalExecution }>("goal/read", { id: goal.id });
      setSummaries(current => ({ ...current, [goal.id]: read.execution }));
    } catch (caught) { setError(errorText(caught)); }
  };
  const act = async (goal: NativeGoal, extra: Record<string, unknown>) => {
    if (pending) return;
    setPending(goal.id); setError("");
    try { await request("goal/update", { id: goal.id, revision: goal.revision, ...extra }); await load(); await refresh(); }
    catch (caught) { setError(errorText(caught)); } finally { setPending(""); }
  };
  const checkpoint = async (goal: NativeGoal) => {
    if (pending) return;
    setPending(goal.id); setError("");
    try { await request("goal/update", { id: goal.id, revision: goal.revision, checkpoint: true }); await load(); }
    catch (caught) { setError(errorText(caught)); } finally { setPending(""); }
  };
  const runGoal = async (goal: NativeGoal) => {
    if (pending) return;
    setPending(goal.id); setError("");
    try {
      const result = await request<{ threadId: string }>("goal/run", { id: goal.id, revision: goal.revision });
      await refresh();
      router.push(`/workbench/task/${encodeURIComponent(result.threadId)}`);
    } catch (caught) { setError(errorText(caught)); } finally { setPending(""); }
  };
  const workspaceTitle = (id: string) => workspaces.find(project => project.id === id)?.title ?? id;
  const when = (stamp?: string | null) => {
    if (!stamp) return "—";
    // The daemon stamps RFC3339-ish fields as "<epochMillis>ms"; parse that
    // shape explicitly instead of letting Date() render "Invalid Date".
    const millis = stamp.endsWith("ms") ? Number(stamp.slice(0, -2)) : Number.NaN;
    const date = Number.isFinite(millis) ? new Date(millis) : new Date(stamp);
    return Number.isNaN(date.getTime()) ? stamp : date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const goals = browserState.goals;
  const loading = connection === "connected" && browserState.loading && !goals.length;
  const query = useMemo(() => ({ scope, workspaceId: scopeProjectId, search, status: filter as "ongoing" | "finished" }), [scope, scopeProjectId, search, filter]);
  // Counts for both tabs come from the same scope/search projection.
  const ongoing = useMemo(() => filterGoals(goals, { ...query, status: "ongoing" }), [goals, query]);
  const finishedAll = useMemo(() => filterGoals(goals, { ...query, status: "finished" }), [goals, query]);
  const visible = filter === "ongoing" ? ongoing : finishedAll;
  const incomplete = browserState.failures.length > 0;
  const shownGoals = visible.slice(0, renderLimit);
  return <div className="nw-page nw-goals">
    <div className="nw-page-heading"><div><h1>{t("长期目标", "Goals")}</h1><p>{t("把大事拆成下一步，一次推进一点。", "Turn a bigger effort into a clear next step.")}</p></div><button className="nw-button nw-button-primary" onClick={() => setEditor({})} disabled={connection !== "connected" || !workspaceId}><Plus size={15} />{t("新建目标", "New goal")}</button></div>
    <div className="nw-filter-bar"><div className="nw-tabs" aria-label={t("目标分类", "Goal categories")}>{[["ongoing", t("推进中", "Ongoing"), ongoing.length], ["finished", t("已结束", "Finished"), finishedAll.length]].map(([key, label, count]) => <button key={key} aria-pressed={filter === key} className={filter === key ? "is-active" : ""} onClick={() => setFilter(String(key))}>{label}<span className="nw-count">{count}{incomplete ? "+" : ""}</span></button>)}</div>
      <label className="nw-file-search"><Search size={13} /><input aria-label={t("搜索目标或验收条件", "Search goals or acceptance criteria")} placeholder={t("搜索目标或验收条件…", "Search goals or criteria…")} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label={t("目标范围", "Goal scope")} value={scope === "single" ? scopeProjectId : ""} onChange={event => { if (!event.target.value) setScope("all"); else { setScope("single"); setScopeProjectId(event.target.value); } }}>
        <option value="">{t("所有项目", "All projects")}</option>
        {missingProject && <option value={scopeProjectId} disabled>{t('项目已不可用', 'Project unavailable')}</option>}
        {workspaces.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      {scope === "single" && <span className="nw-goals-project">{workspaceTitle(scopeProjectId)}</span>}
      {scope === "all" && <span className="nw-goals-project">{t("所有项目", "All projects")}</span>}
    </div>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {missingProject && <p role="note">{t('所选项目已不可用，请选择另一个项目。', 'The selected project is unavailable. Choose another project.')}</p>}
    {incomplete && <p role="note" className="nw-inline-error">{t(`部分项目读取失败（${browserState.failures.map(id => workspaceTitle(id)).join("、")}），以下列表和计数可能不完整。`, `Some projects failed to load (${browserState.failures.map(id => workspaceTitle(id)).join(", ")}); the list and counts may be incomplete.`)}</p>}
    {loading ? <div className="nw-empty-panel" role="status"><Loader2 className="nw-spin" size={22} /><p>{t("正在读取目标…", "Loading goals…")}</p></div> : <div className="nw-goal-list">{shownGoals.map(goal => <GoalCard key={goal.id} goal={goal} summary={summaries[goal.id]} project={workspaceTitle(goal.workspaceId)} checkpointTime={when(goal.lastCheckpointAt)} pending={pending} read={() => loadSummary(goal)} run={() => void runGoal(goal)} review={() => setAcceptance(goal)} checkpoint={() => void checkpoint(goal)} update={status => void act(goal, { status })} edit={() => setEditor({ goal })} />)}{visible.length > shownGoals.length && <button className="nw-button" onClick={() => setRenderLimit(value => value + GOALS_RENDER_LIMIT)}>{t(`显示更多目标（还有 ${visible.length - shownGoals.length} 个）`, `Show more goals (${visible.length - shownGoals.length} more)`)}</button>}</div>}
    {!loading && !visible.length && <div className="nw-automation-empty"><span><Target size={30} /></span><h2>{filter === "finished" ? t("完成的目标，留在这里", "A record of what you've achieved") : t("给一件大事，一个清楚的方向", "Give a bigger effort a clear direction")}</h2><p>{filter === "finished" ? t("已完成或取消的目标会保留过程和结果，方便回顾。", "Completed and cancelled goals keep their progress and results for reference.") : t("写下要完成的事、验收条件和第一步，随时回来继续。", "Write down the goal, what done means, and the first step. Return whenever you're ready.")}</p>{filter === "ongoing" && <button className="nw-button nw-button-primary" onClick={() => setEditor({})} disabled={connection !== "connected" || !workspaceId}><Plus size={15} />{t("创建第一个目标", "Create your first goal")}</button>}</div>}
    {!loading && visible.length > 0 && <p className="nw-goals-note">{t("先执行，再核对结果。验收记录齐全后，才能标记完成。", "Run the work, then review its results. Record acceptance before marking the goal done.")}</p>}
    {acceptance && <GoalAcceptanceDialog goal={acceptance} close={() => setAcceptance(undefined)} saved={load} />}
    {editor && <GoalEditor {...editor} close={() => setEditor(undefined)} saved={load} />}
  </div>;
}
