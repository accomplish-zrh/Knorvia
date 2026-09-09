"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { usePanel } from "./PanelContext";
import { previewUrl, workspaceLink } from "@/lib/native-panel";
import remarkGfm from "remark-gfm";
import { Check, ChevronRight, Copy, FileText, Loader2, Save, ShieldCheck } from "lucide-react";
import { itemText, taskStatus, type Approval, type Item, type ThreadSnapshot } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { goalConversationInput } from "@/lib/native-goals";
import { UserInputCard } from "./UserInputCard";
import { SaveToLibrary } from "./SaveToLibrary";
import { ToolIcon, ToolStatus } from "./ToolVisual";
import { toolPresentation } from "@/lib/native-tool-presentation";
import { SubAgentActivity } from "./SubAgentActivity";

export function Markdown({ text }: { text: string }) {
  const panel = usePanel();
  return <div className="nw-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => (previewUrl(url) || workspaceLink(url, panel?.cwd ?? "", panel?.folder) || url.startsWith("#")) ? url : ""} components={{ a: ({ children, href, ...props }) => <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (!panel || !href || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const url = previewUrl(href), path = workspaceLink(href, panel.cwd, panel.folder);
    if (url) { event.preventDefault(); panel.open({ kind: "browser", url }); }
    else if (path) { event.preventDefault(); panel.open({ kind: "file", path }); }
  }}>{children}</a> }}>{text}</ReactMarkdown></div>;
}

export function ItemDetail({ item }: { item: Item }) {
  const { t } = useWorkbench();
  const p = item.payload;
  if (item.kind === "userInput") {
    if (item.status === "waiting_input") return null;
    const message = item.status === "answered" || item.status === "completed"
      ? t("补充信息已提交", "Additional input submitted")
      : item.status === "timed_out" ? t("补充信息请求已超时", "Input request timed out")
        : item.status === "interrupted" ? t("补充信息请求已中断", "Input request interrupted")
          : t("补充信息未送达，请在后续任务中重新提供", "Input was not delivered. Please provide it in a follow-up.");
    return <p className="nw-event-note"><FileText size={13} />{message}</p>;
  }
  if (item.kind === "commandExecution") return <details className="nw-tool"><summary><ToolIcon item={item} /><span>{String(p.command ?? t("执行命令", "Run command"))}</span>{p.exitCode !== null && p.exitCode !== undefined && <small>{`${t("退出码", "Exit")} ${p.exitCode}`}</small>}<ToolStatus item={item} /><ChevronRight size={14} /></summary><pre>{String(p.aggregatedOutput ?? t("命令未返回文本输出", "No text output"))}</pre></details>;
  if (item.kind === "fileChange") {
    const changes = Array.isArray(p.changes) ? p.changes as { path?: string; diff?: string; kind?: unknown }[] : [];
    return <div className="nw-file-changes">{changes.map((change, index) => <details className="nw-tool" key={index}><summary><ToolIcon item={item} /><span>{change.path ?? t("文件变更", "File change")}</span><ToolStatus item={item} /><ChevronRight size={14} /></summary><pre>{change.diff ?? t("文件已更新", "File updated")}</pre></details>)}</div>;
  }
  if (item.kind === "reasoning") {
    const summary = itemText(item);
    return summary ? <details className="nw-tool nw-thought"><summary><ToolIcon item={item} /><span>{t("工作思路", "Approach")}</span><ChevronRight size={14} /></summary><p>{summary}</p></details> : null;
  }
  if (item.kind === "approvalDecision") return <p className="nw-event-note"><ShieldCheck size={13} />{p.decision === "allowed" ? t("已记录：允许此操作", "Recorded your approval") : t("已记录：拒绝此操作", "Recorded your refusal")}</p>;
  if (item.kind === "approvalDelivery" && (item.status === "failed" || p.delivered === false)) return <div role="alert" className="nw-task-error">{t("审批选择未送达，请检查任务状态后再继续。", "Your approval decision was not delivered. Check the task state before continuing.")}</div>;
  if (item.kind === "tool.write") return null;
  if (item.kind === "tokenUsage") return <details className="nw-tool"><summary><ToolIcon item={item} /><span>{t("本轮用量", "Run usage")}</span><ChevronRight size={14} /></summary><pre>{JSON.stringify(p, null, 2)}</pre></details>;
  if (item.kind === "error") return <div role="alert" className="nw-task-error">{itemText(item) || t("执行遇到问题。你可以补充要求后重试。", "The task encountered a problem. You can send a follow-up to retry.")}</div>;
  const presentation = toolPresentation(item);
  const label = presentation.identity || (typeof p.query === "string" ? p.query : t(presentation.zh, presentation.en));
  return <details className="nw-tool" data-tool-kind={item.kind}><summary><ToolIcon item={item} /><span title={label}>{label}{presentation.category === "tool" && !presentation.identity && <small className="nw-tool-method">{item.kind}</small>}</span><ToolStatus item={item} /><ChevronRight size={14} /></summary><pre>{JSON.stringify(p, null, 2)}</pre></details>;
}

export function ApprovalCard({ approval, thread }: { approval: Approval; thread: ThreadSnapshot }) {
  const { t, request, readThread, setError } = useWorkbench();
  const [pending, setPending] = useState(false);
  const related = thread.items.find(item => item.payload.approvalId === approval.id);
  const target = (approval.target ?? related?.payload.target ?? {}) as Record<string, unknown>;
  const act = async (decision: "allow" | "deny") => {
    setPending(true);
    try { await request("approval/respond", { id: approval.id, decision }); await readThread(thread.id); }
    catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };
  const description = target.command ?? target.reason ?? target.reasoning ?? target.message;
  return <div className="nw-approval" role="group" aria-label={t("操作确认", "Operation approval")}><div className="nw-approval-title"><ShieldCheck size={17} /><strong>{t("这一步需要你确认", "This step needs your approval")}</strong></div><p>{approval.action === "kernel.commandExecution" ? t("Knorvia 请求执行以下命令。", "Knorvia is requesting permission to run this command.") : approval.action === "kernel.fileChange" ? t("Knorvia 请求修改文件。", "Knorvia is requesting permission to edit files.") : t("Knorvia 请求额外权限。", "Knorvia is requesting additional permissions.")}</p>
    {description ? <pre>{typeof description === "string" ? description : JSON.stringify(description, null, 2)}</pre> : <pre>{JSON.stringify(target, null, 2)}</pre>}
    {typeof target.cwd === "string" && <small>{target.cwd}</small>}
    <div className="nw-approval-actions"><button className="nw-button" disabled={pending} onClick={() => void act("deny")}>{t("拒绝", "Decline")}</button><button className="nw-button nw-button-primary" disabled={pending} onClick={() => void act("allow")}>{pending ? <Loader2 size={14} className="nw-spin" /> : <Check size={14} />}{t("允许这次操作", "Allow this operation")}</button></div>
  </div>;
}

export function TaskTimeline({ thread }: { thread: ThreadSnapshot }) {
  const { t, live, saveResult, readThread, setNotice, setError } = useWorkbench();
  const [saving, setSaving] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const liveText = live.filter(item => item.threadId === thread.id);
  const visibleItems = thread.items.filter(item => item.kind !== "tool.write");
  const subAgentsByTurn = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const item of thread.items) if (item.kind === 'subAgent') {
      const items = groups.get(item.turnId) ?? []; items.push(item); groups.set(item.turnId, items);
    }
    return groups;
  }, [thread.items]);
  return <div className="nw-timeline" aria-label={t("任务内容", "Task conversation")}>
    {thread.hasMoreItems && typeof thread.itemsNextCursor === "number" && <button className="nw-load-older" disabled={loadingOlder} onClick={async event => { const scroller = event.currentTarget.closest(".nw-task-scroll, .nw-side-chat-history"); const anchor = scroller?.querySelector<HTMLElement>("[data-item-id]"); const before = anchor?.getBoundingClientRect().top; setLoadingOlder(true); try { await readThread(thread.id, thread.itemsNextCursor ?? undefined); requestAnimationFrame(() => { if (scroller && anchor?.isConnected && before !== undefined) scroller.scrollTop += anchor.getBoundingClientRect().top - before; }); } catch (error) { setError(errorText(error)); } finally { setLoadingOlder(false); } }}>{loadingOlder ? t("正在读取…", "Loading…") : t("加载更早的记录", "Load earlier history")}</button>}
    {visibleItems.map(item => {
      if (item.kind === 'subAgent') {
        const children = subAgentsByTurn.get(item.turnId)!;
        if (children[0]?.id !== item.id) return null;
        return <SubAgentActivity key={`agents-${item.turnId}`} items={children} scope={{ threadId: thread.id, turnId: item.turnId, active: thread.activeTurn?.id === item.turnId }} />;
      }
      if (item.kind === "userMessage") {
        const text = itemText(item);
        const goalInput = goalConversationInput(text, thread.goalId);
        const libraryBoundary = text.indexOf("\n\n[个人资料库上下文]\n");
        const displayText = libraryBoundary >= 0 ? text.slice(0, libraryBoundary) : text;
        return <div className="nw-user-message" data-item-id={item.id} key={item.id}><p>{goalInput?.input ?? displayText}</p>{libraryBoundary >= 0 && <details className="nw-message-goal-context"><summary>{t("随资料发送的上下文", "Included library context")}</summary><pre>{text.slice(libraryBoundary).trim()}</pre></details>}{goalInput && <details className="nw-message-goal-context"><summary>{t("随目标发送的说明", "Included goal instructions")}</summary><pre>{goalInput.context}</pre></details>}</div>;
      }
      if (item.kind !== "agentMessage") return <div key={item.id} data-item-id={item.id}><ItemDetail item={item} /></div>;
      return <article className="nw-agent-message" data-item-id={item.id} key={item.id}><Markdown text={itemText(item)} />
        <div className="nw-message-actions"><SaveToLibrary name={thread.title} text={itemText(item)} /><button className="nw-icon" aria-label={t("复制回复", "Copy response")} title={t("复制回复", "Copy response")} onClick={() => void navigator.clipboard.writeText(itemText(item)).then(() => setNotice(t("已复制", "Copied"))).catch(error => setError(errorText(error)))}><Copy size={14} /></button><button className="nw-save-result" disabled={saving === item.id} onClick={async () => { setSaving(item.id); try { await saveResult(thread, itemText(item)); } catch (error) { setError(errorText(error)); } finally { setSaving(""); } }}>{saving === item.id ? <Loader2 size={14} className="nw-spin" /> : <Save size={14} />}{t("保存为成果", "Save as output")}</button></div>
      </article>;
    })}
    {liveText.map(item => <article className="nw-agent-message nw-streaming-message" key={`${item.turnId}:${item.itemId}`}><Markdown text={item.text} /><span className="nw-stream-caret" /></article>)}
    {thread.pendingApprovals.filter(approval => approval.status === "pending").map(approval => <ApprovalCard key={approval.id} approval={approval} thread={thread} />)}
    {(thread.pendingUserInputs ?? []).map(item => <UserInputCard key={item.id} item={item} />)}
    {thread.activeTurn && <div className="nw-working" role="status">{thread.pendingApprovals.length || thread.pendingUserInputs?.length ? <ShieldCheck size={15} /> : <Loader2 size={15} className="nw-spin" />}{thread.pendingApprovals.length ? t("等待你的确认 · 可以在上方允许或拒绝", "Waiting for you · Approve or decline above") : thread.pendingUserInputs?.length ? t("等待补充信息 · 请回答上方问题", "Waiting for you · Answer the questions above") : t("正在处理任务", "Working on your task")}</div>}
    {!thread.activeTurn && thread.turns.length > 0 && <div className="nw-turn-end" data-status={taskStatus(thread)}><span /><FileText size={13} />{taskStatus(thread) === "failed" ? t("本轮执行失败 · 可以补充要求后重试", "This run failed · Send a follow-up to retry") : taskStatus(thread) === "cancelled" || taskStatus(thread) === "interrupted" ? t("本轮已停止 · 可以继续发送要求", "This run stopped · Send a follow-up to continue") : t("本轮已完成 · 记录已保存", "This run is complete · History saved")}<span /></div>}
  </div>;
}
