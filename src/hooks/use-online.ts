import { useSyncExternalStore } from "react"

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  return () => {
    window.removeEventListener("online", onChange)
    window.removeEventListener("offline", onChange)
  }
}

// Server-/SSR-Snapshot liest navigator mit, falls vorhanden — so lässt sich der
// Offline-Zustand in SSR-Renderproben per navigator-Stub simulieren.
const getSnapshot = () => (typeof navigator === "undefined" ? true : navigator.onLine)

/** Reaktiver navigator.onLine — Flugmodus/Reconnect lösen ein Re-Render aus. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
