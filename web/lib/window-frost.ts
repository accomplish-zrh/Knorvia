/**
 * Window frost — a live acrylic/vibrancy backdrop that is independent of
 * the colour theme. Clarity is how much of the desktop (and other apps)
 * shows through the canvas; plates is how solid reading surfaces stay.
 */

export const WINDOW_FROST_STORAGE_KEY = "knorvia-window-frost"
export const FROST_CLARITY_STORAGE_KEY = "knorvia-frost-clarity"
export const FROST_PLATES_STORAGE_KEY = "knorvia-frost-plates"
export const WINDOW_FROST_EVENT = "knorvia:window-frost"

export const DEFAULT_FROST_CLARITY = 62
export const DEFAULT_FROST_PLATES = 86

export type WindowFrostState = {
  enabled: boolean
  clarity: number
  plates: number
}

type FrostListener = (state: WindowFrostState) => void
const frostListeners = new Set<FrostListener>()

export function subscribeToWindowFrost(listener: FrostListener): () => void {
  frostListeners.add(listener)
  return () => frostListeners.delete(listener)
}

function notifyWindowFrost(state: WindowFrostState): void {
  frostListeners.forEach((listener) => listener(state))
  if (typeof window === "undefined") return
  try {
    window.dispatchEvent(new CustomEvent(WINDOW_FROST_EVENT, { detail: state }))
  } catch {
    /* ignore */
  }
}

export function clampPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function frostMix(clarity: number, plates: number): {
  canvas: number
  sidebar: number
  plate: number
  popover: number
  muted: number
} {
  const seeThrough = clampPercent(clarity, DEFAULT_FROST_CLARITY)
  const solid = clampPercent(plates, DEFAULT_FROST_PLATES)
  const canvas = Math.round(82 - (70 * seeThrough) / 100)
  const sidebar = Math.max(8, Math.round(canvas * 0.62))
  const plate = Math.round(62 + (34 * solid) / 100)
  return {
    canvas,
    sidebar,
    plate,
    popover: Math.min(98, plate + 6),
    muted: Math.round((canvas + plate) / 2),
  }
}

export function readStoredWindowFrost(): WindowFrostState {
  if (typeof window === "undefined") {
    return {
      enabled: false,
      clarity: DEFAULT_FROST_CLARITY,
      plates: DEFAULT_FROST_PLATES,
    }
  }
  try {
    const raw = window.localStorage.getItem(WINDOW_FROST_STORAGE_KEY)
    const theme = window.localStorage.getItem("knorvia-theme")
    const enabled =
      raw === "true" || (raw === null && theme === "glass")
    const clarity = clampPercent(
      Number.parseInt(window.localStorage.getItem(FROST_CLARITY_STORAGE_KEY) || "", 10),
      DEFAULT_FROST_CLARITY,
    )
    const plates = clampPercent(
      Number.parseInt(window.localStorage.getItem(FROST_PLATES_STORAGE_KEY) || "", 10),
      DEFAULT_FROST_PLATES,
    )
    return { enabled, clarity, plates }
  } catch {
    return {
      enabled: false,
      clarity: DEFAULT_FROST_CLARITY,
      plates: DEFAULT_FROST_PLATES,
    }
  }
}

export function applyWindowFrostToDocument(state: WindowFrostState): void {
  if (typeof document === "undefined") return
  const html = document.documentElement
  if (state.enabled) {
    html.setAttribute("data-window-frost", "")
    const mix = frostMix(state.clarity, state.plates)
    html.style.setProperty("--frost-canvas", `${mix.canvas}%`)
    html.style.setProperty("--frost-sidebar", `${mix.sidebar}%`)
    html.style.setProperty("--frost-plate", `${mix.plate}%`)
    html.style.setProperty("--frost-popover", `${mix.popover}%`)
    html.style.setProperty("--frost-muted", `${mix.muted}%`)
  } else {
    html.removeAttribute("data-window-frost")
    html.style.removeProperty("--frost-canvas")
    html.style.removeProperty("--frost-sidebar")
    html.style.removeProperty("--frost-plate")
    html.style.removeProperty("--frost-popover")
    html.style.removeProperty("--frost-muted")
  }
}

export function saveWindowFrost(state: WindowFrostState): WindowFrostState {
  const next = {
    enabled: Boolean(state.enabled),
    clarity: clampPercent(state.clarity, DEFAULT_FROST_CLARITY),
    plates: clampPercent(state.plates, DEFAULT_FROST_PLATES),
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(WINDOW_FROST_STORAGE_KEY, String(next.enabled))
      window.localStorage.setItem(FROST_CLARITY_STORAGE_KEY, String(next.clarity))
      window.localStorage.setItem(FROST_PLATES_STORAGE_KEY, String(next.plates))
    } catch {
      /* localStorage may be unavailable */
    }
  }
  applyWindowFrostToDocument(next)
  notifyWindowFrost(next)
  return next
}

export function syncLoadedWindowFrost(ui: {
  window_frost?: unknown
  frost_clarity?: unknown
  frost_plates?: unknown
  theme?: unknown
}): WindowFrostState {
  const enabled =
    ui.window_frost === true ||
    ui.window_frost === "true" ||
    (ui.window_frost == null && ui.theme === "glass")
  const clarity = clampPercent(Number(ui.frost_clarity), DEFAULT_FROST_CLARITY)
  const plates = clampPercent(Number(ui.frost_plates), DEFAULT_FROST_PLATES)
  return saveWindowFrost({ enabled, clarity, plates })
}
