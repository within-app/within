interface RateLimitEntry {
  count: number
  resetAt: number
}

// In-Memory Store — wird beim App-Neustart zurückgesetzt (OK für Single-Instance)
const store = new Map<string, RateLimitEntry>()

// Throttle the O(n) cleanup sweep — run at most once per 10 s to keep it off the hot path.
let lastCleanup = 0
function cleanup(): void {
  const now = Date.now()
  if (now - lastCleanup < 10_000) return
  lastCleanup = now
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key)
  }
}

/** Clears the in-memory store. Only for use in tests. */
export function resetStore(): void {
  store.clear()
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfter: number // Sekunden bis das Fenster zurückgesetzt wird
}

function increment(key: string, windowMs: number): { count: number; resetAt: number } {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    const next = { count: 1, resetAt: now + windowMs }
    store.set(key, next)
    return next
  }

  entry.count++
  return entry
}

/**
 * Checks (and increments) the rate-limit bucket for a given IP + type.
 *
 * @param ip              Client IP address (use "untrusted" as a shared key when
 *                        the real IP cannot be determined).
 * @param type            "login" or "api".
 * @param maxRequests     Per-IP maximum requests in the window.
 * @param windowMs        Window length in milliseconds (default 60 s).
 * @param globalMaxLogin  Optional global ceiling for "login" attempts across ALL
 *                        IPs in the same window.  When provided and exceeded,
 *                        the request is blocked even if the per-IP bucket is
 *                        still open.  Pass undefined to skip the global check.
 */
export function checkRateLimit(
  ip: string,
  type: "login" | "api",
  maxRequests: number,
  windowMs = 60_000,
  globalMaxLogin?: number
): RateLimitResult {
  cleanup()

  // --- Global login backstop (checked first, incremented regardless) ---
  if (type === "login" && globalMaxLogin !== undefined) {
    const globalEntry = increment("GLOBAL:login", windowMs)
    if (globalEntry.count > globalMaxLogin) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil((globalEntry.resetAt - Date.now()) / 1000),
      }
    }
  }

  // --- Per-IP bucket ---
  const perIpEntry = increment(`${ip}:${type}`, windowMs)

  if (perIpEntry.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((perIpEntry.resetAt - Date.now()) / 1000),
    }
  }

  return { allowed: true, remaining: maxRequests - perIpEntry.count, retryAfter: 0 }
}
