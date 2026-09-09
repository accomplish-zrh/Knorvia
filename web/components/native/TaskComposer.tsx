"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronDown, FileText, Folder, Loader2, Paperclip, Plus, ShieldCheck, Square, Target, X } from "lucide-react";
import type { ThreadSnapshot } from "@/lib/native-workbench-state";
import type { NativeGoal } from "@/lib/knorvia-native-types";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { appendFileReferences } from "@/lib/native-project-context";
import { clearSubmission, submissionAttempt } from "@/lib/native-submission";
import { providerError, providerLabel } from "@/lib/native-providers";

type Attachment = { name: string; content: string };
type GoalDraft = { criteria: string; constraints: string };
export function TaskComposer({ thread, goal, suggestion, onSuggestionUsed, contextFiles = [], onRemoveContextFile, onContextFilesUsed, onCreate, draftScope, projectId }: { thread?: ThreadSnapshot; goal?: NativeGoal; suggestion?: string; onSuggestionUsed?: () => void; contextFiles?: string[]; onRemoveContextFile?: (path: string) => void; onContextFilesUsed?: (paths: string[]) => void; onCreate?: (text: string, options: { workspaceId: string; model?: string; reasoningEffort?: string; cwd?: string; write: boolean; submissionId?: string }) => Promise<string>; draftScope?: string; projectId?: string }) {
  const { t, connection, connectionInfo, models, workspaces, workspaceId, setWorkspaceId, newTask, sendTurn, readThread, request, setError } = useWorkbench();
  const router = useRouter();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const submitting = useRef(false);
  const lastAttempt = useRef<Awaited<ReturnType<typeof submissionAttempt>> | undefined>(undefined);
  const [model, setModel] = useState("");
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [effort, setEffort] = useState("");
  const [write, setWrite] = useState(true);
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [goalDraft, setGoalDraft] = useState<GoalDraft | null>(null);
  const goalAttempt = useRef<{ fingerprint: string; createKey: string; runKey: string; goal?: NativeGoal } | null>(null);
  const addAnchor = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const draftKey = `knorvia-native-draft:${draftScope ?? thread?.id ?? "new"}`;
  const currentDraftKey = useRef(draftKey); currentDraftKey.current = draftKey;
  const workspace = workspaces.find(project => project.id === (thread?.workspaceId ?? projectId ?? workspaceId));
  const running = thread?.activeTurn?.status === "running";
  const needsDecision = Boolean(thread?.pendingApprovals.some(approval => approval.status === "pending") || thread?.pendingUserInputs?.length);
  const effectiveModel = model || connectionInfo?.model || "";
  const currentProvider = connectionInfo?.providers.find(p => p.id === connectionInfo.activeProviderId);
  const selectedModel = effectiveModel ? models.find(entry => (entry.model ?? entry.id) === effectiveModel) : models.find(entry => entry.isDefault);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effectiveEffort = efforts.some(entry => entry.reasoningEffort === effort) ? effort : "";
  // C15: switching to a model that does not support the previously chosen
  // effort clears the stale selection instead of sending an unsupported field.
  useEffect(() => {
    if (selectedModel && effort && !efforts.some(entry => entry.reasoningEffort === effort)) setEffort("");
  }, [effort, efforts, selectedModel]);
  useEffect(() => { setModel(""); setEffort(""); }, [connectionInfo?.activeProviderId]);

  useEffect(() => {
    try { setInput(localStorage.getItem(draftKey) ?? ""); } catch { setInput(""); }
    try {
      const saved = JSON.parse(localStorage.getItem(`${draftKey}:goal`) ?? "null");
      setGoalDraft(!thread?.id && typeof saved?.criteria === "string" && typeof saved?.constraints === "string" ? saved : null);
    } catch { setGoalDraft(null); }
    try {
      const saved = JSON.parse(localStorage.getItem(`${draftKey}:attachments`) ?? '[]');
      setAttachments(Array.isArray(saved) && saved.length <= 4 && saved.every(file => typeof file.name === 'string' && typeof file.content === 'string') && new Blob(saved.map(file => file.content)).size <= 48 * 1024 ? saved : []);
    } catch { setAttachments([]); }
    setLoadingFiles(false);
  }, [draftKey, thread?.id]);

  useEffect(() => {
    if (!addMenu) return;
    const outside = (event: PointerEvent) => { if (!addAnchor.current?.contains(event.target as Node)) setAddMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setAddMenu(false); addAnchor.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [addMenu]);

  const updateGoalDraft = (next: GoalDraft | null) => {
    setGoalDraft(next);
    try { if (next) localStorage.setItem(`${draftKey}:goal`, JSON.stringify(next)); else localStorage.removeItem(`${draftKey}:goal`); } catch { /* optional draft cache */ }
  };

  useEffect(() => {
    setModel(thread?.model ?? "");
    setEffort(thread?.reasoningEffort ?? "");
  }, [thread?.id, thread?.model, thread?.reasoningEffort]);

  useEffect(() => {
    if (suggestion) {
      setInput(suggestion);
      try { localStorage.setItem(draftKey, suggestion); } catch { /* optional draft cache */ }
      textarea.current?.focus(); onSuggestionUsed?.();
    }
  }, [suggestion, onSuggestionUsed, draftKey]);

  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const resize = () => { field.style.height = "0px"; field.style.height = `${Math.min(field.scrollHeight, 220)}px`; };
    resize();
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== lastWidth) { lastWidth = width; resize(); }
    });
    let lastWidth = field.getBoundingClientRect().width;
    observer.observe(field);
    return () => observer.disconnect();
  }, [input, expanded, needsDecision]);

  const updateInput = (value: string) => {
    setInput(value);
    try { if (value) localStorage.setItem(draftKey, value); else localStorage.removeItem(draftKey); } catch { /* optional draft cache */ }
  };

  const keepAttachments = (next: Attachment[]) => {
    setAttachments(next);
    try { if (next.length) localStorage.setItem(`${draftKey}:attachments`, JSON.stringify(next)); else localStorage.removeItem(`${draftKey}:attachments`); } catch { /* optional draft storage */ }
  };

  const submit = async () => {
    // A retry's identity includes its provider/model. Do not admit it while a
    // reload is still resolving those values, or it could acquire a new key.
    if ((!input.trim() && attachments.length === 0 && contextFiles.length === 0) || submitting.current || pending || switchingProvider || loadingFiles || connection !== "connected" || !connectionInfo || !workspace || (goalDraft && (!input.trim() || !goalDraft.criteria.trim()))) return;
    const text = [appendFileReferences(input.trim(), contextFiles), ...attachments.map(file => `\n<attached_text_file name=${JSON.stringify(file.name)}>\n${file.content}\n</attached_text_file>`)].filter(Boolean).join("\n");
    const submittedInput = input;
    const submittedAttachments = attachments;
    const submittedContextFiles = contextFiles;
    submitting.current = true; setPending(true); setError("");
    try {
      let storage: Storage | undefined; try { storage = localStorage; } catch { /* current attempt remains in memory */ }
      const candidate = await submissionAttempt(storage, draftKey, [workspace.id, thread?.id, text, goalDraft, connectionInfo?.activeProviderId, effectiveModel, effectiveEffort, write], running ? { kind: 'steer', turnId: thread.activeTurn!.id } : { kind: 'start' });
      const attempt = lastAttempt.current?.fingerprint === candidate.fingerprint ? lastAttempt.current : candidate;
      lastAttempt.current = attempt;
      if (thread && attempt.action.kind === 'steer' && attempt.action.turnId) {
        await request("turn/steer", { threadId: thread.id, turnId: attempt.action.turnId, input: text, clientMessageId: attempt.id });
        void readThread(thread.id).catch(error => setError(errorText(error)));
      } else if (thread?.goalId) {
        const latest = await request<NativeGoal>("goal/read", { id: thread.goalId });
        await request("goal/run", { id: latest.id, revision: latest.revision, threadId: thread.id, input: text, tools: { write }, ...(effectiveModel ? { model: effectiveModel } : {}), reasoningEffort: effectiveEffort || null, idempotencyKey: `${attempt.id}-goal-run` });
        void readThread(thread.id).catch(error => setError(errorText(error)));
      } else if (thread) {
        await sendTurn(thread.id, text, { model: effectiveModel, reasoningEffort: effectiveEffort, write, cwd: thread.cwd ?? workspace.cwd ?? undefined, submissionId: attempt.id });
      } else if (goalDraft) {
        const fingerprint = JSON.stringify([workspace.id, text, goalDraft, connectionInfo?.activeProviderId, effectiveModel, effectiveEffort, write]);
        if (goalAttempt.current?.fingerprint !== fingerprint) goalAttempt.current = { fingerprint, createKey: `${attempt.id}-goal-create`, runKey: `${attempt.id}-goal-run` };
        const goalSubmission = goalAttempt.current!;
        goalSubmission.goal ??= await request<NativeGoal>("goal/create", { workspaceId: workspace.id, title: input.trim().split("\n")[0].slice(0, 200), successCriteria: goalDraft.criteria.trim(), constraints: goalDraft.constraints.trim(), nextAction: text, idempotencyKey: goalSubmission.createKey });
        const started = await request<{ threadId: string }>("goal/run", { id: goalSubmission.goal.id, revision: goalSubmission.goal.revision, input: text, tools: { write }, ...(effectiveModel ? { model: effectiveModel } : {}), reasoningEffort: effectiveEffort || null, ...(workspace.cwd ? { cwd: workspace.cwd } : {}), idempotencyKey: goalSubmission.runKey });
        try { if (localStorage.getItem(`${draftKey}:goal`) === JSON.stringify(goalDraft)) localStorage.removeItem(`${draftKey}:goal`); } catch { /* optional draft cache */ }
        router.push(`/workbench/task/${encodeURIComponent(started.threadId)}`);
        // Admission succeeded. A later refresh must not turn it into a second send.
        void readThread(started.threadId).catch(error => setError(errorText(error)));
      } else {
        await (onCreate ?? newTask)(text, { workspaceId: workspace.id, model: effectiveModel, reasoningEffort: effectiveEffort, write, cwd: workspace.cwd ?? undefined, submissionId: attempt.id });
      }
      // A completed send may belong to a composer the user already left.
      // Never clear a newer draft written while that request was pending.
      setInput(current => current === submittedInput ? "" : current);
      try { if (localStorage.getItem(draftKey) === submittedInput) localStorage.removeItem(draftKey); } catch { /* optional draft cache */ }
      setAttachments(current => current === submittedAttachments ? [] : current);
      try { if (localStorage.getItem(`${draftKey}:attachments`) === JSON.stringify(submittedAttachments)) localStorage.removeItem(`${draftKey}:attachments`); } catch { /* optional draft storage */ }
      clearSubmission(storage, draftKey, attempt.id); lastAttempt.current = undefined;
      onContextFilesUsed?.(submittedContextFiles);
    } catch (error) { setError(errorText(error)); } finally { submitting.current = false; setPending(false); }
  };

  const stop = async () => {
    if (!thread?.activeTurn || stopping) return;
    setStopping(true);
    try { await request("turn/interrupt", { turnId: thread.activeTurn.id }); await readThread(thread.id); }
    catch (error) { setError(errorText(error)); }
    finally { setStopping(false); }
  };

  if (goal && goal.status !== "active" && !running) return <p className="nw-goal-composer-state">{["paused", "blocked"].includes(goal.status) ? t("目标已暂停，继续后可在这段对话里推进。", "Resume this goal to continue in this conversation.") : t("这个目标已结束，对话和结果已保留。", "This goal has ended. The conversation and results are saved.")}</p>;

  if (needsDecision && !expanded) return <div className="nw-decision-prompt"><div><ShieldCheck size={17} /><span>{thread?.pendingUserInputs?.length ? t("请先回答上方问题", "Answer the questions above") : t("请先确认上方操作", "Review the operation above")}</span></div><div><button className="nw-button nw-button-small" onClick={() => { setExpanded(true); requestAnimationFrame(() => textarea.current?.focus()); }}>{t("补充任务要求", "Add instructions")}</button><button className="nw-stop" onClick={() => void stop()} disabled={stopping} aria-label={t("停止任务", "Stop task")} title={t("停止任务", "Stop task")}>{stopping ? <Loader2 size={15} className="nw-spin" /> : <Square size={12} fill="currentColor" />}</button></div></div>;

  return <div className="nw-composer-wrap">
    {needsDecision && <button className="nw-compose-collapse" onClick={() => setExpanded(false)}><ChevronDown size={14} />{t("收起输入，查看待处理事项", "Collapse to review the pending request")}</button>}
    <div className="nw-composer">
      {goalDraft && <div className="nw-goal-mode-label"><Target size={15} /><strong>{t("目标模式", "Goal mode")}</strong><span>{t("记录目标，按完成条件推进", "Work toward a defined outcome")}</span><button className="nw-icon" disabled={pending} onClick={() => updateGoalDraft(null)} aria-label={t("退出目标模式", "Exit goal mode")}><X size={14} /></button></div>}
      {contextFiles.length > 0 && <div className="nw-attachments nw-context-files">{contextFiles.map(path => <span key={path} title={path}><FileText size={14} /><span>{path}</span><button className="nw-icon" onClick={() => onRemoveContextFile?.(path)} aria-label={`${t("移除文件引用", "Remove file reference")}: ${path}`}><X size={12} /></button></span>)}</div>}
      {attachments.length > 0 && <div className="nw-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><FileText size={14} />{file.name}<button className="nw-icon" onClick={() => keepAttachments(attachments.filter((_, i) => i !== index))} aria-label={t("移除附件", "Remove attachment")}><X size={12} /></button></span>)}</div>}
      <textarea ref={textarea} aria-describedby={hintId} aria-label={running ? t("补充任务要求", "Add instructions") : t("任务描述", "Task description")} value={input} onChange={event => updateInput(event.target.value)} placeholder={thread ? (running ? t("补充要求，调整正在进行的工作…", "Add context or steer the work in progress…") : t("继续这个任务…", "Continue this task…")) : t("描述你想完成的事，或添加资料…", "Describe what you want to do, or add your files…")} rows={thread ? 2 : 3} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} />
      {goalDraft && <div className="nw-goal-mode-fields"><label>{t("完成条件", "Completion criteria")}<textarea aria-label={t("完成条件", "Completion criteria")} value={goalDraft.criteria} rows={2} maxLength={4000} disabled={pending} placeholder={t("怎样才算完成？写下可以核对的结果。", "What should be true when this is done?")} onChange={event => updateGoalDraft({ ...goalDraft, criteria: event.target.value })} /></label><details><summary>{t("约束（可选）", "Constraints (optional)")}</summary><textarea aria-label={t("目标约束", "Goal constraints")} rows={2} maxLength={4000} disabled={pending} value={goalDraft.constraints} onChange={event => updateGoalDraft({ ...goalDraft, constraints: event.target.value })} placeholder={t("工作范围、需要保留的内容…", "Scope, what to preserve…")} /></details></div>}
      <div className="nw-composer-toolbar"><div className="nw-composer-options">
        <div className="nw-composer-add" ref={addAnchor}><button className="nw-icon" onClick={() => setAddMenu(!addMenu)} aria-expanded={addMenu} aria-label={t("添加内容或模式", "Add content or mode")}><Plus size={19} /></button>{addMenu && <div className="nw-popover nw-add-popover"><button onClick={() => { setAddMenu(false); fileInput.current?.click(); }}><Paperclip size={16} />{t("附加文本文件", "Attach text files")}</button>{!thread && !onCreate && <button aria-label={goalDraft ? t("普通对话", "Regular conversation") : t("目标", "Goal")} disabled={pending} onClick={() => { updateGoalDraft(goalDraft ? null : { criteria: "", constraints: "" }); setAddMenu(false); textarea.current?.focus(); }}><Target size={16} /><span>{goalDraft ? t("普通对话", "Regular conversation") : t("目标", "Goal")}<small>{goalDraft ? t("退出目标模式", "Exit goal mode") : t("设置要推进的目标", "Set an outcome to work toward")}</small></span></button>}</div>}</div>
        <input ref={fileInput} disabled={loadingFiles || pending} hidden type="file" multiple accept=".txt,.md,.json,.csv,.tsv,.log,.py,.js,.ts,.tsx,.html,.css,.yaml,.yml,.toml,.xml,.sql" onChange={async event => {
          const files = [...(event.target.files ?? [])]; event.target.value = "";
          if (files.length + attachments.length > 4 || files.reduce((sum, file) => sum + file.size, 0) + attachments.reduce((sum, file) => sum + new Blob([file.content]).size, 0) > 48 * 1024) { setError(t("每次最多附加 4 个文本文件，总计 48 KB。较大文件请放入项目文件夹。", "Attach up to 4 text files, 48 KB total. Place larger files in the project folder.")); return; }
          setLoadingFiles(true);
          try {
            const loaded = await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })));
            if (currentDraftKey.current !== draftKey) return;
            if (loaded.some(file => file.content.includes("\0"))) throw new Error(t("请选择可读的文本文件。", "Please choose readable text files."));
            keepAttachments([...attachments, ...loaded]);
          } catch (error) { setError(errorText(error)); } finally { if (currentDraftKey.current === draftKey) setLoadingFiles(false); }
        }} />
        <label className="nw-select-label nw-permission-select"><ShieldCheck size={13} /><span>{write ? t("项目内可编辑", "Project edits allowed") : t("只读", "Read only")}</span><ChevronDown size={12} /><select aria-label={t("任务权限", "Task permissions")} value={write ? "write" : "read"} disabled={running} onChange={event => setWrite(event.target.value === "write")}><option value="write">{t("项目内可编辑", "Project edits allowed")}</option><option value="read">{t("只读", "Read only")}</option></select></label>
        {connectionInfo && connectionInfo.providers.length > 1 && <label className="nw-select-label nw-provider-select" title={t("切换工作台当前提供商", "Switch the workspace provider")}><span>{providerLabel(currentProvider, t)}</span>{switchingProvider ? <Loader2 size={12} className="nw-spin" /> : <ChevronDown size={12} />}<select aria-label={t("选择提供商", "Choose provider")} value={connectionInfo.activeProviderId} disabled={running || pending || switchingProvider || connection !== "connected"} onChange={async event => {
          const provider = connectionInfo.providers.find(p => p.id === event.target.value);
          if (!provider) return;
          setSwitchingProvider(true); setError("");
          try { await request("connection/provider/activate", { id: provider.id, revision: provider.revision }); }
          catch (error) { setError(providerError(error, t)); } finally { setSwitchingProvider(false); }
        }}>{connectionInfo.providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.configured && provider.id !== connectionInfo.activeProviderId}>{providerLabel(provider, t)}</option>)}</select></label>}
        <label className="nw-select-label nw-model-select"><span>{selectedModel?.displayName ?? (effectiveModel || t("默认模型", "Default model"))}</span><ChevronDown size={12} /><select aria-label={t("选择模型", "Choose model")} disabled={running || switchingProvider || connection !== "connected"} value={model} onChange={event => { setModel(event.target.value); setEffort(""); }}><option value="">{t("默认模型", "Default model")}{connectionInfo?.model ? ` · ${connectionInfo.model}` : ""}</option>{models.map(entry => <option key={entry.id} value={entry.model ?? entry.id}>{entry.displayName ?? entry.model ?? entry.id}</option>)}</select></label>
        {efforts.length > 0 && <label className="nw-select-label nw-effort-select"><span>{effort || t("默认推理", "Default effort")}</span><ChevronDown size={12} /><select aria-label={t("推理强度", "Reasoning effort")} value={effort} disabled={running} onChange={event => setEffort(event.target.value)}><option value="">{t("默认推理", "Default effort")}</option>{efforts.map(entry => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{entry.reasoningEffort}</option>)}</select></label>}
      </div><div className="nw-send-actions">{running && <button className="nw-stop" onClick={() => void stop()} disabled={stopping} aria-label={t("停止任务", "Stop task")} title={t("停止任务", "Stop task")}>{stopping ? <Loader2 size={15} className="nw-spin" /> : <Square size={12} fill="currentColor" />}</button>}<button className="nw-send" onClick={() => void submit()} disabled={pending || switchingProvider || !connectionInfo || connection !== "connected" || (!input.trim() && attachments.length === 0 && contextFiles.length === 0) || !workspace || Boolean(goalDraft && (!input.trim() || !goalDraft.criteria.trim()))} aria-label={running ? t("发送补充要求", "Send additional instructions") : t("发送任务", "Send task")}>{pending ? <Loader2 size={18} className="nw-spin" /> : <ArrowUp size={19} />}</button></div></div>
    </div>
    <div className="nw-composer-foot"><label className="nw-select-label nw-project-select" title={thread?.cwd ?? workspace?.cwd ?? undefined}><Folder size={13} /><span>{workspace?.title ?? t("选择项目", "Choose project")}</span>{!thread && <><ChevronDown size={12} /><select aria-label={t("选择项目", "Choose project")} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>{workspaces.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></>}</label>
      <span id={hintId} className="nw-enter-hint">{connection !== "connected" ? t("连接后可发送，文字草稿自动保留", "Connect to send; your text draft is saved") : !workspace ? t("先选择或新建一个项目", "Choose or create a project to begin") : running ? t("补充信息会送入当前任务", "Instructions join the current task") : t("Enter 发送 · Shift Enter 换行", "Enter to send · Shift Enter for a new line")}</span>
    </div>
  </div>;
}
