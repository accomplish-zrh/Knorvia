/** True when the UI is running inside the Knorvia desktop shell. */
export function isKnorviaDesktop(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { knorviaDesktop?: unknown }).knorviaDesktop)
}

export function isWindowsDesktop(): boolean {
  return isKnorviaDesktop() && /Windows/i.test(navigator.userAgent)
}
