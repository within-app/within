import { NextRequest, NextResponse } from "next/server"
import { unsealData } from "iron-session"
import { SESSION_COOKIE_NAME } from "@/lib/session"
import type { SessionData } from "@/lib/session"
import { checkRateLimit } from "@/lib/rate-limiter"
import { getClientIpFromEnv } from "@/lib/get-client-ip"
import { generateNonce, buildCspWithNonce } from "@/lib/csp"

// Routen die ohne Login erreichbar sein müssen
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/api/health"]

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

/**
 * Returns the base URL (protocol + host) as seen by the client.
 *
 * In Next.js standalone mode the server binds to HOSTNAME (default 0.0.0.0),
 * so request.url / request.nextUrl carry that internal address rather than the
 * client-visible hostname.  We reconstruct from:
 *   - Host header   — the hostname the client actually used (e.g. "app:4000")
 *   - x-forwarded-proto — the outer protocol when running behind a trusted reverse
 *     proxy (Caddy on the Pi sets TRUSTED_PROXY_COUNT=1 and x-forwarded-proto=https)
 */
function clientBaseUrl(request: NextRequest): string {
  const trustedProxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10)
  const xfp = request.headers.get("x-forwarded-proto")
  const protocol = trustedProxyCount > 0 && xfp === "https" ? "https:" : request.nextUrl.protocol
  const host = request.headers.get("host") || request.nextUrl.host
  return `${protocol}//${host}`
}

function redirectToLogin(request: NextRequest): NextResponse {
  // API-Aufrufe bekommen 401 JSON, keine HTML-Weiterleitung
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Nicht autorisiert", code: "unauthorized" }, { status: 401 })
  }
  const loginUrl = new URL("/login", clientBaseUrl(request))
  // Ursprüngliche URL merken damit nach Login direkt weitergeleitet wird
  const from = request.nextUrl.pathname + request.nextUrl.search
  if (from !== "/") {
    loginUrl.searchParams.set("from", from)
  }
  return NextResponse.redirect(loginUrl)
}

function applyRateLimit(request: NextRequest, pathname: string): NextResponse | null {
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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // Generate nonce and forward to app via request headers
  const nonce = generateNonce()
  const csp = buildCspWithNonce(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)

  function applyNonce(response: NextResponse): NextResponse {
    response.headers.set("Content-Security-Policy", csp)
    return response
  }

  // Rate Limiting vor Auth-Check (auch für public paths wie /api/auth/login)
  const rateLimitResponse = applyRateLimit(request, pathname)
  if (rateLimitResponse) return applyNonce(rateLimitResponse)

  if (isPublicPath(pathname)) {
    return applyNonce(NextResponse.next({ request: { headers: requestHeaders } }))
  }

  const sessionSecret = process.env.SESSION_SECRET

  // SESSION_SECRET nicht gesetzt → App nicht nutzbar, zur Login-Seite
  if (!sessionSecret) {
    if (pathname.startsWith("/api/")) {
      return applyNonce(
        NextResponse.json({ error: "SESSION_SECRET ist nicht konfiguriert", code: "config_session_secret_missing" }, { status: 500 })
      )
    }
    return applyNonce(NextResponse.redirect(new URL("/login", clientBaseUrl(request))))
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value

  if (!sessionCookie) {
    return applyNonce(redirectToLogin(request))
  }

  try {
    const data = await unsealData<SessionData>(sessionCookie, { password: sessionSecret })

    if (!data.authenticated || Date.now() > data.expiresAt) {
      return applyNonce(redirectToLogin(request))
    }
  } catch {
    // Ungültiges oder manipuliertes Cookie
    return applyNonce(redirectToLogin(request))
  }

  return applyNonce(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  // Middleware auf alle Routen außer Next.js-interne Assets anwenden.
  // map/ enthält nur statische Karten-Assets (MapLibre-Worker-Paar, Glyph-
  // Schriften) — ohne Ausnahme würde der Worker-Fetch je nach Credentials-
  // Modus auf /login umgeleitet und die Karte bliebe leer.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon\\.svg|manifest\\.webmanifest|sw\\.js|map/).*)"],
}
