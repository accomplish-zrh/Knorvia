"use client";

import { useEffect, useState } from "react";
import { Blocks, ChevronRight, Puzzle } from "lucide-react";
import type { Pack } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { ExtensionManager } from "./ExtensionManager";

function DiscoveredCapabilities() {
  const { t, request, connection, workspaces, workspaceId } = useWorkbench();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [skills, setSkills] = useState<{ name: string; description: string; path: string; enabled: boolean }[]>([]);
  const [tab, setTab] = useState("skills");
  const [skillError, setSkillError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const cwd = workspaces.find(project => project.id === workspaceId)?.cwd;
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    void request<Pack[]>("capability/list").then(value => { if (!cancelled) setPacks(value); }).catch(error => { if (!cancelled) setError(errorText(error)); });
    void request<{ data: { skills: typeof skills; errors?: { message: string }[] }[] }>("skills/list", { ...(cwd ? { cwds: [cwd] } : {}) }).then(value => {
      if (cancelled) return;
      setSkills([...new Map((value.data ?? []).flatMap(entry => entry.skills).map(skill => [skill.path, skill])).values()]);
      setSkillError((value.data ?? []).flatMap(entry => entry.errors ?? []).map(error => error.message).join("\n"));
    }).catch(error => { if (!cancelled) setSkillError(errorText(error)); });
    return () => { cancelled = true; };
  }, [request, connection, cwd]);
  return <div className="nw-extension-discovery-content"><div className="nw-page-heading"><div><h2>{t("已发现的能力", "Discovered capabilities")}</h2><p>{t("用专门的能力扩展工作范围。", "Specialized capabilities for the work you want to do.")}</p></div></div><div className="nw-extension-note"><Puzzle size={20} /><div><strong>{t("一个工作台，按需扩展", "One workspace, room to grow")}</strong><p>{t("学习、创作和其他领域能力归入扩展。这里展示当前运行环境实际发现的能力。", "Learning, creative work, and other specialized capabilities live in extensions. This list reflects what your runtime has discovered.")}</p></div></div><div className="nw-tabs nw-extension-tabs"><button className={tab === "skills" ? "is-active" : ""} aria-pressed={tab === "skills"} onClick={() => setTab("skills")}>{"Skills"}</button><button className={tab === "packs" ? "is-active" : ""} aria-pressed={tab === "packs"} onClick={() => setTab("packs")}>{t("独立能力", "Capabilities")}</button></div>{tab === "skills" ? <>{skillError && <p role="alert" className="nw-inline-error">{skillError}</p>}<div className="nw-pack-list">{skills.map(skill => <div className="nw-skill-row" key={skill.path}><Puzzle size={19} /><div><strong>{skill.name}</strong><p>{skill.description}</p></div><span>{skill.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}</span></div>)}</div>{!skills.length && !skillError && <div className="nw-empty-panel"><Puzzle size={28} /><h2>{t("这个项目还没有技能", "No skills in this project yet")}</h2><p>{t("项目和工作引擎中可用的技能会在这里显示。", "Skills available to this project and runtime will appear here.")}</p></div>}</> : <>{error && <p role="alert" className="nw-inline-error">{error}</p>}<div className="nw-pack-list">{packs.map(pack => <div className="nw-pack" key={pack.id}><button aria-expanded={selected === pack.id} onClick={() => setSelected(selected === pack.id ? "" : pack.id)}><span className="nw-pack-icon"><Blocks size={20} /></span><span><strong>{pack.name ?? pack.id.replace(/^knorvia[.-]/, "")}</strong><small>{pack.description ?? pack.publisher ?? pack.id}</small></span><span className="nw-pack-version">{pack.version}</span><ChevronRight size={15} /></button>{selected === pack.id && <div className="nw-pack-detail"><span>{t("能力清单", "Capabilities")}</span><div>{(pack.capabilities ?? []).map(capability => <code key={capability}>{capability}</code>)}</div><p>{t("独立能力的可用性取决于相应工具和运行环境。", "Each capability requires its corresponding tools and runtime.")}</p></div>}</div>)}</div>{!packs.length && !error && <div className="nw-empty-panel"><Puzzle size={28} /><h2>{t("扩展会出现在这里", "Your extensions will appear here")}</h2><p>{t("连接运行环境后查看可用能力。", "Connect your runtime to see available capabilities.")}</p></div>}</>}</div>;
}

export function ExtensionsView() {
  const { workspaceId, t } = useWorkbench();
  return <div className="nw-page nw-extensions-page"><ExtensionManager workspaceId={workspaceId || undefined} /><details className="nw-extension-discovered"><summary><Puzzle size={18} /><span>{t('查看工作引擎发现的能力', 'Capabilities discovered by the engine')}</span><ChevronRight size={17} /></summary><DiscoveredCapabilities /></details></div>;
}
