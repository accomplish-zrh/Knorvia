import { useSyncExternalStore } from "react";

let hostActive = true;
const listeners = new Set<() => void>();

export function setDirectorDeskHostActive(active: boolean) {
  if (hostActive === active) return;
  hostActive = active;
  listeners.forEach((listener) => listener());
}

export function getDirectorDeskHostActive() {
  return hostActive;
}

export function subscribeDirectorDeskHostActive(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDirectorDeskHostActive() {
  return useSyncExternalStore(
    subscribeDirectorDeskHostActive,
    getDirectorDeskHostActive,
    () => true
  );
}
