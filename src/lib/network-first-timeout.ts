/**
 * Network-first views (timeline, detail) fall back to IndexedDB when the
 * fetch fails — but "WLAN up, Pi down" only fails at the TCP timeout, so the
 * skeleton sat there although everything is local. Abort after 6 s instead.
 */
export const NETWORK_FIRST_TIMEOUT_MS = 6000

/** Aborts `controller` after `ms`; returns the cleanup for the effect teardown. */
export function abortAfter(controller: AbortController, ms = NETWORK_FIRST_TIMEOUT_MS): () => void {
  const timer = setTimeout(() => controller.abort(), ms)
  return () => clearTimeout(timer)
}
