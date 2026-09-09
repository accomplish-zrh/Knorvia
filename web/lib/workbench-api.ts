/** Workbench client: Knorvia Protocol surfaces over /api/v1/knorvia/*. */

export type WorkbenchPack = {
  id: string
  version: string
  publisher: string
  capabilities: string[]
}

export type WorkbenchWorkspace = {
  id: string
  title: string
  revision: number
}

export type WorkbenchArtifact = {
  id: string
  title: string
  type: string
  lifecycle: string
  workspaceId: string
}

export const WORKBENCH_NAV = [
  { href: "/workbench", label: "New task" },
  { href: "/workbench/projects", label: "Projects" },
  { href: "/workbench/history", label: "All tasks" },
  { href: "/workbench/artifacts", label: "Outputs" },
  { href: "/workbench/packs", label: "Extensions" },
  { href: "/workbench/settings", label: "Settings" },
] as const

export function knorviaApiPath(kind: "packs" | "workspaces" | "artifacts" | "activity"): string {
  return `/api/v1/knorvia/${kind}`
}

export function packInvokePath(): string {
  return "/api/v1/knorvia/packs/invoke"
}

export function isWorkbenchHref(href: string): boolean {
  return href === "/workbench" || href.startsWith("/workbench/")
}
