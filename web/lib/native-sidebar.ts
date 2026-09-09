import { nativeTimestamp, type Thread } from "./native-workbench-state";

export type SidebarSection = { id: string; title: string; threadIds: string[] };
export type SidebarPreferences = {
  grouping: "project" | "list";
  sort: "updated" | "created";
  pinned: string[];
  collapsedProjects: string[];
  collapsedSections: string[];
  sections: SidebarSection[];
  collapsed: boolean;
};
export const sidebarDefaults: SidebarPreferences = { grouping: "project", sort: "updated", pinned: [], collapsedProjects: [], collapsedSections: [], sections: [], collapsed: false };
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, 10000) : [];

/** UI organization is device-local. It never changes a task's durable workspace. */
export function parseSidebarPreferences(raw: string): SidebarPreferences {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return sidebarDefaults;
    const pinned = strings(value.pinned), claimed = new Set(pinned), ids = new Set<string>();
    const sections: SidebarSection[] = [];
    for (const section of Array.isArray(value.sections) ? value.sections.slice(0, 50) : []) {
      if (!section || typeof section.id !== "string" || !section.id || ["pinned", "projects", "recent"].includes(section.id) || ids.has(section.id) || typeof section.title !== "string" || !section.title.trim()) continue;
      ids.add(section.id);
      const threadIds = strings(section.threadIds).filter(id => { if (claimed.has(id)) return false; claimed.add(id); return true; });
      sections.push({ id: section.id, title: section.title.trim().slice(0, 80), threadIds });
    }
    return { grouping: value.grouping === "list" ? "list" : "project", sort: value.sort === "created" ? "created" : "updated", pinned, sections, collapsedProjects: strings(value.collapsedProjects), collapsedSections: strings(value.collapsedSections), collapsed: value.collapsed === true };
  } catch { return sidebarDefaults; }
}

export function organizeThread(prefs: SidebarPreferences, threadId: string, destination: string | null): SidebarPreferences {
  if (destination && destination !== "pinned" && !prefs.sections.some(section => section.id === destination)) return prefs;
  return { ...prefs, pinned: [...prefs.pinned.filter(id => id !== threadId), ...(destination === "pinned" ? [threadId] : [])], sections: prefs.sections.map(section => ({ ...section, threadIds: [...section.threadIds.filter(id => id !== threadId), ...(destination === section.id ? [threadId] : [])] })) };
}

export function sortSidebarThreads(threads: Thread[], sort: SidebarPreferences["sort"]): Thread[] {
  const stamp = (value: string) => { const parsed = nativeTimestamp(value); return Number.isFinite(parsed) ? parsed : 0; };
  return threads.filter(thread => thread.status !== "archived").sort((a, b) => stamp(sort === "created" ? b.createdAt : b.updatedAt) - stamp(sort === "created" ? a.createdAt : a.updatedAt) || a.id.localeCompare(b.id));
}
