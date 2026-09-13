"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bell, DatabaseBackup, Download, Gauge, HardDrive, Info, Keyboard, Menu, Palette, PlugZap, Search, Server, Settings2, ShieldCheck, SquareTerminal, X, Zap } from "lucide-react";
import { useDrawerFocus } from "./useDrawerFocus";
import { useWorkbench } from "./NativeWorkbenchProvider";

export const settingSections = [
  { id: "general", zh: "常规", en: "General", group: "personal", icon: Settings2, keywords: "语言 language 默认项目 workspace" },
  { id: "appearance", zh: "外观", en: "Appearance", group: "personal", icon: Palette, keywords: "主题 明亮 深色 暖纸 雾蓝 青苔 暮紫 玻璃 磨砂 亚克力 透明度 配色 theme light dark glass frost acrylic transparency color 背景 图片 上传 模糊 wallpaper background image upload blur 阅读 字号 宽度 动效 reading text font size width motion" },
  { id: "shortcuts", zh: "键盘快捷键", en: "Keyboard shortcuts", group: "personal", icon: Keyboard, keywords: "按键 搜索 输入 keyboard search" },
  { id: "notifications", zh: "通知", en: "Notifications", group: "personal", icon: Bell, keywords: "轮次 任务 完成 提醒 免打扰 通知 sound quiet hours notifications" },
  { id: "connection", zh: "模型与连接", en: "Models and connection", group: "workspace", icon: PlugZap, keywords: "api 服务 密钥 模型 model key runtime provider 运行环境" },
  { id: "usage", zh: "用量", en: "Usage", group: "workspace", icon: Gauge, keywords: "token 用量 仪表盘 统计 usage dashboard model 模型 趋势 trend" },
  { id: "ssh", zh: "远程连接", en: "Remote connections", group: "workspace", icon: Server, keywords: "ssh sftp 服务器 终端 文件 远程 remote server" },
  { id: "terminal", zh: "终端", en: "Terminal", group: "workspace", icon: SquareTerminal, keywords: "终端 shell 配置 默认 terminal profiles shell bash powershell" },
  { id: "storage", zh: "资料库空间", en: "Library storage", group: "workspace", icon: HardDrive, keywords: "资料库 空间 回收站 历史版本 清理 library storage trash history cleanup disk 磁盘" },
  { id: "update", zh: "更新", en: "Updates", group: "workspace", icon: Download, keywords: "更新 升级 下载 校验 安装包 version update upgrade download digest installer 新版本" },
  { id: "backup", zh: "备份与恢复", en: "Backup and restore", group: "workspace", icon: DatabaseBackup, keywords: "备份 恢复 迁移 home backup restore migrate 迁移到新目录 数据" },
  { id: "integrity", zh: "组件完整性", en: "Runtime integrity", group: "workspace", icon: ShieldCheck, keywords: "完整性 校验 组件 清单 integrity manifest tampered 被替换 混包 engine kernel" },
  { id: "power", zh: "电源与长任务", en: "Power and long tasks", group: "personal", icon: Zap, keywords: "电源 休眠 唤醒 电池 长任务 power sleep awake battery prevent-app-suspension 防休眠" },
  { id: "about", zh: "关于 Knorvia", en: "About Knorvia", group: "workspace", icon: Info, keywords: "版本 version 工作台" },
];

export function SettingsLayout({ children, back }: { children: React.ReactNode; back: string }) {
  const { t } = useWorkbench();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const drawer = useRef<HTMLElement>(null);
  useDrawerFocus(mobileNav, drawer, () => setMobileNav(false));
  const active = pathname.split("/")[3] || "general";
  const activeSection = settingSections.find(section => section.id === active);
  const matches = settingSections.filter(section => `${section.zh} ${section.en} ${section.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); if (window.matchMedia("(max-width: 650px)").matches) setMobileNav(true); requestAnimationFrame(() => search.current?.focus());
      }
      if (event.key === "Escape") setMobileNav(false);
    };
    const screen = window.matchMedia("(max-width: 650px)");
    const resize = () => { if (!screen.matches) setMobileNav(false); };
    document.addEventListener("keydown", keydown); screen.addEventListener("change", resize);
    return () => { document.removeEventListener("keydown", keydown); screen.removeEventListener("change", resize); };
  }, []);
  return <div className={`nw-settings-layout ${mobileNav ? "is-nav-open" : ""}`}>
    <div className="nw-settings-titlebar" data-desktop-drag="" aria-hidden="true" />
    {mobileNav && <button className="nw-settings-scrim" aria-label={t("关闭设置导航", "Close settings navigation")} onClick={() => setMobileNav(false)} />}
    <aside ref={drawer} className="nw-settings-sidebar" aria-label={t("设置导航", "Settings navigation")}>
      <div className="nw-settings-back"><Link href={back}><ArrowLeft size={17} />{t("返回应用", "Back to app")}</Link><button className="nw-icon" onClick={() => setMobileNav(false)} aria-label={t("收起设置导航", "Hide settings navigation")}><X size={17} /></button></div>
      <div className="nw-settings-search" role="search"><Search size={16} aria-hidden="true" /><input ref={search} aria-label={t("搜索设置", "Search settings")} placeholder={t("搜索设置…", "Search settings…")} value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" className="nw-icon" onClick={() => { setQuery(""); search.current?.focus(); }} aria-label={t("清空设置搜索", "Clear settings search")}><X size={14} /></button> : <kbd aria-hidden="true">Ctrl K</kbd>}</div>
      <nav aria-label={t("设置分类", "Settings categories")}>{["personal", "workspace"].map(group => matches.some(section => section.group === group) && <div key={group} className="nw-settings-nav-group"><h2>{group === "personal" ? t("个人", "Personal") : t("工作台", "Workspace")}</h2>{matches.filter(section => section.group === group).map(section => <Link href={`/workbench/settings/${section.id}`} key={section.id} aria-current={active === section.id ? "page" : undefined} onClick={() => setMobileNav(false)}><section.icon size={17} aria-hidden="true" /><span>{t(section.zh, section.en)}</span></Link>)}</div>)}</nav>
      {!matches.length && <div className="nw-settings-no-results" role="status"><strong>{t("没有匹配的设置", "No matching settings")}</strong><p>{t("试试“主题”“模型”或“通知”。", "Try “theme”, “model” or “notifications”.")}</p></div>}
    </aside>
    <div className="nw-settings-main" inert={mobileNav}><header className="nw-settings-mobile-bar"><button className="nw-icon" onClick={() => setMobileNav(true)} aria-label={t("展开设置导航", "Show settings navigation")} aria-expanded={mobileNav}><Menu size={18} /></button><span>{activeSection ? t(activeSection.zh, activeSection.en) : t("设置", "Settings")}</span><Link href={back} aria-label={t("返回应用", "Back to app")}><ArrowLeft size={17} /></Link></header><main className="nw-view" id="nw-content" tabIndex={-1}>{children}</main></div>
  </div>;
}
