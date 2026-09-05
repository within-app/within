/**
 * Extracts the real client IP from request headers, respecting a configurable
 * number of trusted reverse-proxy hops.
 *
 * TRUSTED_PROXY_COUNT (env):
 *   0  — Fail-closed default: trust NO header (both X-Forwarded-For and X-Real-IP
 *         are client-settable and must not be used).  Returns "unknown" — all
 *         untrusted traffic shares one rate-limit bucket.  Use this only when the
 *         app is exposed directly without a reverse proxy.
 *   N≥1 — Trust N proxy hops.  Each trusted proxy appends the IP it received the
 *          connection from to the XFF chain (rightmost = most recently appended).
 *          The real client IP is therefore the Nth entry from the right.
 *          If the XFF chain has fewer than N entries, the value cannot be trusted;
 *          return "untrusted" to fail closed rather than falling back to a
 *          client-supplied (spoofable) value.
 *
 * The Pi deployment runs behind Caddy — set TRUSTED_PROXY_COUNT=1 in .env.
 * Without it, all login attempts share "unknown" and the 100/min global backstop
 * is the only protection.
 */

export interface HeaderLike {
  get(name: string): string | null
}

/** Shared key returned when the XFF chain cannot be trusted (fail-closed). */
const UNTRUSTED_KEY = "untrusted"

export function getClientIp(headers: HeaderLike, trustedProxyCount: number): string {
  if (trustedProxyCount <= 0) {
    // Fail-closed: both XFF and X-Real-IP are client-settable; trust neither.
    return "unknown"
  }

  const forwarded = headers.get("x-forwarded-for")
  if (!forwarded || forwarded.trim() === "") {
    // XFF absent or empty — fail closed
    return UNTRUSTED_KEY
  }

  const entries = forwarded.split(",").map((s) => s.trim()).filter(Boolean)

  if (entries.length < trustedProxyCount) {
    // Fewer entries than trusted hops — something is wrong; fail closed
    return UNTRUSTED_KEY
  }

  // The Nth entry from the right is the IP added by the outermost trusted proxy,
  // which is the IP of the actual connecting client.
  return entries[entries.length - trustedProxyCount]
}

/**
 * Convenience wrapper that reads TRUSTED_PROXY_COUNT from the environment.
 * Accepts a NextRequest-compatible headers object (has `.get(name)`).
 */
export function getClientIpFromEnv(headers: HeaderLike): string {
  const count = parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10)
  return getClientIp(headers, isNaN(count) || count < 0 ? 0 : count)
}
