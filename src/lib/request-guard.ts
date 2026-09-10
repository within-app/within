import { NextRequest, NextResponse } from "next/server"
import { unsealData } from "iron-session"
import { SESSION_COOKIE_NAME } from "@/lib/session"
import type { SessionData } from "@/lib/session"
import { checkRateLimit } from "@/lib/rate-limiter"
import { getClientIpFromEnv } from "@/lib/get-client-ip"

/**
 * Request guard shared by the proxy and the API routes its matcher skips.
 *
 * Why routes skip the proxy: with Node middleware Next clones every non-GET
 * body into memory (cloneBodyStream + finalize in next-server.js) before the
 * route handler runs — a 100 MB video became 100 MB of off-heap buffers no
 * matter how the route streams. /api/upload and /api/import therefore run
 * rate limit + session check themselves, through these same functions.
 *
 * Same limits, separate bucket in production: Turbopack compiles the
 * middleware as its own module layer, so rate-limiter.ts (and its store Map)
 * exists twice in the build. Upload/import get their own 60/min per IP and do
 * not eat the sync budget — only under Vitest do both share one store.
 */

export function apiUnauthorized(): NextResponse {
  return NextResponse.json({ error: "Nicht autorisiert", code: "unauthorized" }, { status: 401 })
}

export function apiSecretMissing(): NextResponse {
  return NextResponse.json(
    { error: "SESSION_SECRET ist nicht konfiguriert", code: "config_session_secret_missing" },
    { status: 500 }
  )
}

export function applyRateLimit(request: NextRequest, pathname: string): NextResponse | null {
  // Use trusted-hop IP extraction — TRUSTED_PROXY_COUNT from env (default 0)
  const ip = getClientIpFromEnv(request.headers)
  const isLoginEndpoint = pathname === "/api/auth/login"

  if (isLoginEndpoint) {
    const max = parseInt(process.env.RATE_LIMIT_LOGIN_MAX ?? "5", 10)
    const globalMax = parseInt(process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX ?? "100", 10)
    const result = checkRateLimit(ip, "login", max, 60_000, globalMax)
    if (!result.allowed) {
      return NextResponse.json(
        { error: `Zu viele Versuche, bitte warte ${result.retryAfter} Sekunden`, code: "rate_limited_login", retryAfter: result.retryAfter },
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfter) },
        }
      )
    }
    return null
  }

  if (pathname.startsWith("/api/")) {
    const max = parseInt(process.env.RATE_LIMIT_API_MAX ?? "60", 10)
    const result = checkRateLimit(ip, "api", max)
    if (!result.allowed) {
      return NextResponse.json(
        { error: `Zu viele Anfragen, bitte warte ${result.retryAfter} Sekunden`, code: "rate_limited", retryAfter: result.retryAfter },
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfter) },
        }
      )
    }
  }

  return null
}

export type SessionVerdict = "ok" | "missing_secret" | "unauthorized"

export async function verifySession(request: NextRequest): Promise<SessionVerdict> {
  const sessionSecret = process.env.SESSION_SECRET
  if (!sessionSecret) return "missing_secret"

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!sessionCookie) return "unauthorized"

  try {
    const data = await unsealData<SessionData>(sessionCookie, { password: sessionSecret })
    return data.authenticated && Date.now() <= data.expiresAt ? "ok" : "unauthorized"
  } catch {
    // Ungültiges oder manipuliertes Cookie
    return "unauthorized"
  }
}

/** Rate limit, then session — the proxy's order — for routes outside its matcher. */
export async function guardApiRequest(request: NextRequest): Promise<NextResponse | null> {
  const limited = applyRateLimit(request, request.nextUrl.pathname)
  if (limited) return limited
  const verdict = await verifySession(request)
  if (verdict === "missing_secret") return apiSecretMissing()
  if (verdict === "unauthorized") return apiUnauthorized()
  return null
}
