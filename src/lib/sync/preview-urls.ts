/**
 * Object-URL bookkeeping, extracted from
 * pending-media-preview.ts so it runs in the node test environment (that file
 * imports realIDBAdapter and cannot be loaded under vitest/node).
 *
 * No IDB, no React — only guarded `URL.*` calls. The lifecycle rules live with
 * the callers: the detail view revokes on effect teardown, the timeline keeps a
 * cache per outbox id (see pending-media-preview.ts module header).
 */

/** Object URL for `blob`, or "" when the platform or the call refuses. */
export function createPreviewUrl(blob: Blob): string {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return ""
  try {
    return URL.createObjectURL(blob)
  } catch (err) {
    // Never swallow: on a phone the console is out of reach and an empty preview
    // is indistinguishable from "no photo attached".
    console.error("[within/pending-media] creating the preview URL failed:", err)
    return ""
  }
}

/** Revoke every URL handed out into `urls` and empty it. Safe to call twice. */
export function revokePreviewUrls(urls: string[]): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // A URL revoked twice is not a problem worth reporting.
    }
  }
  urls.length = 0
}

/** Revoke every cached preview URL and empty the cache. For unmount. */
export function clearPreviewUrlCache(urlCache: Map<string, string>): void {
  revokePreviewUrls([...urlCache.values()])
  urlCache.clear()
}
