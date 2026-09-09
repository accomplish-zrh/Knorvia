"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, FolderOpen, Loader2, RefreshCw, Search } from "lucide-react";
import { THEME_PALETTES } from "@/lib/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { ConnectionSettings } from "./ConnectionSettings";
import { settingSections } from "./SettingsLayout";
import { UsageSettings } from "./UsageSettings";
import { NotificationSettings } from "./NotificationSettings";
import { FileLocationSettings } from "./FileLocationSettings";
import { RemoteWorkspace } from "./RemoteWorkspace";
import { WorkbenchMark } from "./WorkbenchMark";

function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <div className="nw-preference-row"><div><strong>{title}</strong>{description && <p>{description}</p>}</div><div className="nw-preference-control">{children}</div></div>;
}

export function SettingsView({ section = "general" }: { section?: string }) {
  const { t, locale, toggleLocale, theme, workspaces, workspaceId, connection, models, modelError, reconnect, request, setError } = useWorkbench();
  const [shortcutQuery, setShortcutQuery] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const project = workspaces.find(item => item.id === workspaceId);
  const current = settingSections.find(item => item.id === section);
  const descriptions: Record<string, string> = {
    general: t("让工作台适合你的工作方式。", "Make the workspace feel right for you."),
    appearance: t("为专注工作选择舒适的外观。", "Choose a comfortable look for focused work."),
    shortcuts: t("常用操作，触手可及。", "Keep everyday actions close at hand."),
    notifications: t("选择何时提醒，让专注不被打断。", "Choose when to be notified, with room to focus."),
    connection: t("保存和管理你的模型服务连接。", "Save and manage your model service connections."),
    usage: t("了解每个模型的用量与缓存表现。", "Understand model usage and cache performance."),
    ssh: t("连接远程环境，继续手边的工作。", "Connect to a remote environment and keep working."),
    about: t("从想法到结果的通用工作台。", "A general workspace for turning ideas into results."),
  };
  const shortcuts = [
    { title: t("打开设置", "Open settings"), keys: ["Ctrl", ","] },
    { title: t("保存资料", "Save a library file"), description: t("在资料库编辑时保存原文件", "Save the original file while editing in the library"), keys: ["Ctrl", "S"] },
    { title: t("在对话中查找", "Find in conversation"), description: t("Enter 下一个，Shift Enter 上一个，Esc 关闭", "Enter for next, Shift Enter for previous, Esc to close"), keys: ["Ctrl", "F"] },
    { title: t("搜索任务", "Search tasks"), description: t("设置页中搜索设置分类", "Search settings categories while in settings"), keys: ["Ctrl", "K"] },
    { title: t("新对话", "New conversation"), description: t("回到新任务输入框", "Return to a new task"), keys: ["Ctrl", "Shift", "O"] },
    { title: t("展开或收起左侧栏", "Toggle left sidebar"), description: t("让对话获得更多空间", "Make more room for the conversation"), keys: ["Ctrl", "B"] },
    { title: t("展开或收起右侧面板", "Toggle right panel"), description: t("在任务中查看文件、改动和活动", "View files, changes and activity in a task"), keys: ["Ctrl", "Alt", "B"] },
    { title: t("发送消息", "Send message"), description: t("中文输入法选词期间不会发送", "Does not send during input method composition"), keys: ["Enter"] },
    { title: t("输入框换行", "New line in the composer"), keys: ["Shift", "Enter"] },
    { title: t("关闭菜单或面板", "Close a menu or panel"), keys: ["Esc"] },
  ].filter(item => `${item.title} ${item.description ?? ""} ${item.keys.join(" ")}`.toLowerCase().includes(shortcutQuery.toLowerCase()));
  return <div className="nw-settings-content">
    <header className="nw-preferences-title"><h1>{current ? t(current.zh, current.en) : t("没有这项设置", "Setting not found")}</h1>{descriptions[section] && <p>{descriptions[section]}</p>}</header>
    {!current && <Link className="nw-button" href="/workbench/settings/general">{t("返回常规设置", "Back to general settings")}</Link>}
    {section === "general" && <><section className="nw-preference-section"><h2>{t("偏好", "Preferences")}</h2><div className="nw-preference-card"><SettingRow title={t("语言", "Language")} description={t("工作台的显示语言", "The language used in the workspace")}><select aria-label={t("界面语言", "Interface language")} value={locale} onChange={event => { if (event.target.value !== locale) toggleLocale(); }}><option value="zh">{"简体中文"}</option><option value="en">{"English"}</option></select></SettingRow><SettingRow title={t("外观", "Appearance")} description={t("主题、玻璃效果与透明度", "Themes, glass and transparency")}><Link className="nw-setting-link" href="/workbench/settings/appearance">{t(THEME_PALETTES[theme].zh, THEME_PALETTES[theme].en)}<ArrowUpRight size={14} /></Link></SettingRow></div></section><section className="nw-preference-section"><h2>{t("工作空间", "Workspace")}</h2><div className="nw-preference-card"><SettingRow title={t("当前项目", "Current project")} description={project?.cwd || t("新任务使用在侧栏或输入框中选择的项目", "New tasks use the project selected in the sidebar or composer")}><Link className="nw-setting-link" href={project ? `/workbench/project/${encodeURIComponent(project.id)}` : "/workbench/projects"}><FolderOpen size={15} /><span>{project?.title || t("选择项目", "Choose a project")}</span></Link></SettingRow><SettingRow title={t("整理侧栏", "Sidebar organization")} description={t("在侧栏菜单中选择分组与排序，置顶常用任务或创建分区。", "Use sidebar menus to group, sort, pin tasks or create sections.")}><span className="nw-muted-label">{t("保存在此设备", "Saved on this device")}</span></SettingRow></div></section></>}
    {section === "general" && <FileLocationSettings />}
    {section === "appearance" && <AppearanceSettings />}
    {section === "shortcuts" && <section className="nw-preference-section"><label className="nw-shortcut-search"><Search size={16} /><input aria-label={t("搜索快捷键", "Search shortcuts")} placeholder={t("搜索操作或按键…", "Search actions or keys…")} value={shortcutQuery} onChange={event => setShortcutQuery(event.target.value)} /></label><div className="nw-preference-card">{shortcuts.map(item => <SettingRow key={item.title} title={item.title} description={item.description}><span className="nw-shortcut-keys">{item.keys.map(key => <kbd key={key}>{key}</kbd>)}</span></SettingRow>)}{!shortcuts.length && <p className="nw-settings-no-results" role="status">{t("没有匹配的快捷键", "No matching shortcuts")}</p>}</div></section>}
    <div hidden={section !== "connection"}>
      <ConnectionSettings />
      <section className="nw-preference-section"><h2>{t("运行环境", "Runtime")}</h2><div className="nw-preference-card"><SettingRow title={t("本地连接", "Local connection")} description={connection === "connected" ? t("任务与执行状态已连接", "Connected to tasks and their execution state") : t("尚未连接到工作引擎", "Not connected to the task engine")}><button className="nw-button" disabled={reconnecting} onClick={async () => { setReconnecting(true); try { await reconnect(); } catch (error) { setError(errorText(error)); } finally { setReconnecting(false); } }}>{reconnecting ? <Loader2 className="nw-spin" size={15} /> : <RefreshCw size={15} />}{t("重新连接", "Reconnect")}</button></SettingRow><details className="nw-model-catalog"><summary>{t("查看可用模型", "Available models")}<span>{models.length}</span></summary><p className="nw-help">{t("模型清单来自工作引擎，服务支持情况取决于连接配置。", "Models come from the engine. Provider support depends on your connection.")}</p>{modelError && <p className="nw-inline-error" role="alert">{modelError}</p>}<div className="nw-model-list">{models.map(model => <div key={model.id}><strong>{model.displayName ?? model.model ?? model.id}</strong><p>{model.description}</p>{model.isDefault && <span>{t("默认", "Default")}</span>}</div>)}</div></details></div></section>
    </div>
    {section === "usage" && <UsageSettings />}
    {section === "notifications" && <NotificationSettings />}
    {section === "ssh" && <RemoteWorkspace />}
    {section === "about" && <section className="nw-preference-section"><div className="nw-about-brand"><WorkbenchMark hero /><div><h2>{"Knorvia"}</h2><p>{t("通用智能工作台", "Your agent workspace")}</p><span>{t("版本", "Version")} {process.env.NEXT_PUBLIC_APP_VERSION || "1.1.0"}</span></div></div><div className="nw-preference-card"><SettingRow title={t("执行环境", "Execution environment")} description={t("项目、任务与成果由本地工作引擎管理。", "Projects, tasks and outputs are managed by the local engine.")}><span className="nw-muted-label">{connection === "connected" ? t("已连接", "Connected") : t("未连接", "Disconnected")}</span></SettingRow><SettingRow title={t("快捷键", "Keyboard shortcuts")}><Link className="nw-setting-link" href="/workbench/settings/shortcuts">{t("查看快捷键", "View shortcuts")}<ArrowUpRight size={14} /></Link></SettingRow></div></section>}
  </div>;
}
