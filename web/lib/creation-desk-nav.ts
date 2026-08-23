/** Which creation-desk child the current path belongs to, if any. */
export type CreationDeskChild = "write" | "image" | "video"

export type CreationDeskNavState = {
  /** True when the path is inside the creation desk — the group should show open. */
  open: boolean
  child: CreationDeskChild | null
}

const CHILDREN: ReadonlyArray<{ prefix: string; child: CreationDeskChild }> = [
  { prefix: "/co-writer", child: "write" },
  { prefix: "/image-studio", child: "image" },
  { prefix: "/video-studio", child: "video" },
]

function pathOnly(pathname: string): string {
  const raw = String(pathname || "")
  const cut = raw.split(/[?#]/, 1)[0] || ""
  if (cut.length > 1 && cut.endsWith("/")) return cut.slice(0, -1)
  return cut || "/"
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * Given a workspace pathname, say whether 创作台 should appear open and
 * which of Co-Writer / Image Studio / Video Studio is current.
 */
export function creationDeskNavState(pathname: string): CreationDeskNavState {
  const path = pathOnly(pathname)
  for (const item of CHILDREN) {
    if (matchesPrefix(path, item.prefix)) {
      return { open: true, child: item.child }
    }
  }
  return { open: false, child: null }
}
