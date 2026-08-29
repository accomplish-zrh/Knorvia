/**
 * In-app photo wallpaper. Independent of the colour theme and of window frost.
 * The photo is a CSS background in our renderer; frosted panels sit on top.
 */

export const WALLPAPER_STORAGE_KEY = "knorvia-wallpaper"
export const WALLPAPER_DIM_KEY = "knorvia-wallpaper-dim"
export const WALLPAPER_FIT_KEY = "knorvia-wallpaper-fit"
export const WALLPAPER_EVENT = "knorvia:wallpaper"
export const DEFAULT_WALLPAPER_DIM = 32

export const BUILTIN_WALLPAPERS = [
  { id: "campus-quad", file: "campus-quad.jpg", title: "Golden Quad", src: "/wallpapers/campus-quad.jpg" },
  { id: "campus-library", file: "campus-library.jpg", title: "Library evening", src: "/wallpapers/campus-library.jpg" },
  { id: "campus-lake", file: "campus-lake.jpg", title: "Reading lawn", src: "/wallpapers/campus-lake.jpg" },
  { id: "campus-courtyard", file: "campus-courtyard.jpg", title: "Covered walk", src: "/wallpapers/campus-courtyard.jpg" },
  { id: "campus-night", file: "campus-night.jpg", title: "Lecture Hall Dusk", src: "/wallpapers/campus-night.jpg" },
] as const

export type WallpaperFit = "cover" | "contain"

export type WallpaperState = {
  id: string
  src: string | null
  fit: WallpaperFit
  dim: number
}

type WallpaperListener = (state: WallpaperState) => void
const wallpaperListeners = new Set<WallpaperListener>()

export function subscribeToWallpaper(listener: WallpaperListener): () => void {
  wallpaperListeners.add(listener)
  return () => wallpaperListeners.delete(listener)
}

function notifyWallpaper(state: WallpaperState): void {
  wallpaperListeners.forEach((listener) => listener(state))
  if (typeof window === "undefined") return
  try {
    window.dispatchEvent(new CustomEvent(WALLPAPER_EVENT, { detail: state }))
  } catch {
    /* ignore */
  }
}

export function clampWallpaperDim(value: number, fallback = DEFAULT_WALLPAPER_DIM): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function sanitizeWallpaperFit(value: unknown): WallpaperFit {
  return value === "contain" ? "contain" : "cover"
}

export function sanitizeWallpaperId(value: unknown): string {
  if (value === "custom") return "custom"
  if (typeof value === "string" && BUILTIN_WALLPAPERS.some((item) => item.id === value)) {
    return value
  }
  return "none"
}

function builtinSrc(id: string): string | null {
  const item = BUILTIN_WALLPAPERS.find((entry) => entry.id === id)
  return item ? item.src : null
}

export function wallpaperSceneFromPath(pathname: string): "home" | "work" {
  const path = (pathname || "/").split("?")[0]
  if (path === "/" || path === "/home") return "home"
  return "work"
}

export function applyWallpaperToDocument(state: WallpaperState): void {
  if (typeof document === "undefined") return
  const html = document.documentElement
  const id = sanitizeWallpaperId(state.id)
  const src = id === "none" ? null : state.src || builtinSrc(id)
  if (id !== "none" && src) {
    html.setAttribute("data-wallpaper", id)
    html.style.setProperty("--wallpaper-image", `url("${src}")`)
    html.style.setProperty("--wallpaper-dim", `${clampWallpaperDim(state.dim)}%`)
    html.style.setProperty("--wallpaper-fit", sanitizeWallpaperFit(state.fit))
  } else {
    html.removeAttribute("data-wallpaper")
    html.style.removeProperty("--wallpaper-image")
    html.style.removeProperty("--wallpaper-dim")
    html.style.removeProperty("--wallpaper-fit")
  }
}

function emptyState(): WallpaperState {
  return { id: "none", src: null, fit: "cover", dim: DEFAULT_WALLPAPER_DIM }
}

export function readStoredWallpaper(): WallpaperState {
  if (typeof window === "undefined") return emptyState()
  try {
    const id = sanitizeWallpaperId(window.localStorage.getItem(WALLPAPER_STORAGE_KEY))
    const fit = sanitizeWallpaperFit(window.localStorage.getItem(WALLPAPER_FIT_KEY))
    const dim = clampWallpaperDim(
      Number.parseInt(window.localStorage.getItem(WALLPAPER_DIM_KEY) || "", 10),
    )
    return {
      id,
      src: id === "custom" ? null : builtinSrc(id),
      fit,
      dim,
    }
  } catch {
    return emptyState()
  }
}

export function saveWallpaper(state: WallpaperState): WallpaperState {
  const id = sanitizeWallpaperId(state.id)
  const next: WallpaperState = {
    id,
    src: id === "none" ? null : state.src || builtinSrc(id),
    fit: sanitizeWallpaperFit(state.fit),
    dim: clampWallpaperDim(state.dim),
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(WALLPAPER_STORAGE_KEY, next.id)
      window.localStorage.setItem(WALLPAPER_FIT_KEY, next.fit)
      window.localStorage.setItem(WALLPAPER_DIM_KEY, String(next.dim))
    } catch {
      /* localStorage may be unavailable */
    }
  }
  applyWallpaperToDocument(next)
  notifyWallpaper(next)
  return next
}

function mergeDesktop(payload: { id?: string; src?: string | null } | null | undefined): WallpaperState {
  const current = readStoredWallpaper()
  return saveWallpaper({
    id: payload?.id || "none",
    src: payload?.src ?? null,
    fit: current.fit,
    dim: current.dim,
  })
}

export async function loadDesktopWallpaper(): Promise<WallpaperState> {
  const api = typeof window !== "undefined" ? window.knorviaDesktop?.wallpaper : undefined
  if (api?.getState) {
    try {
      return mergeDesktop(await api.getState())
    } catch {
      /* renderer may boot before IPC is ready */
    }
  }
  const stored = readStoredWallpaper()
  applyWallpaperToDocument(stored)
  return stored
}

export async function chooseBuiltinWallpaper(id: string): Promise<WallpaperState> {
  const api = typeof window !== "undefined" ? window.knorviaDesktop?.wallpaper : undefined
  if (api?.setBuiltin) {
    try {
      return mergeDesktop(await api.setBuiltin(id))
    } catch {
      /* fall through to CSS-only apply */
    }
  }
  return saveWallpaper({ ...readStoredWallpaper(), id, src: builtinSrc(id) })
}

export async function importCustomWallpaper(): Promise<WallpaperState> {
  const api = typeof window !== "undefined" ? window.knorviaDesktop?.wallpaper : undefined
  if (api?.importCustom) {
    try {
      return mergeDesktop(await api.importCustom())
    } catch {
      return readStoredWallpaper()
    }
  }
  return readStoredWallpaper()
}

export async function clearWallpaper(): Promise<WallpaperState> {
  const api = typeof window !== "undefined" ? window.knorviaDesktop?.wallpaper : undefined
  if (api?.clear) {
    try {
      return mergeDesktop(await api.clear())
    } catch {
      /* fall through */
    }
  }
  return saveWallpaper({ ...readStoredWallpaper(), id: "none", src: null })
}

export function syncLoadedWallpaper(ui: {
  wallpaper?: unknown
  wallpaper_source?: unknown
  wallpaper_enabled?: unknown
  wallpaper_fit?: unknown
  wallpaper_dim?: unknown
}): WallpaperState {
  const rawId =
    typeof ui.wallpaper === "string" && ui.wallpaper
      ? ui.wallpaper
      : ui.wallpaper_source
  const enabled = ui.wallpaper_enabled
  let id = sanitizeWallpaperId(rawId)
  if (enabled === false || enabled === "false") id = "none"
  if (enabled === true && id === "none") id = sanitizeWallpaperId(ui.wallpaper_source)
  return saveWallpaper({
    id,
    src: builtinSrc(id),
    fit: sanitizeWallpaperFit(ui.wallpaper_fit),
    dim: clampWallpaperDim(Number(ui.wallpaper_dim)),
  })
}