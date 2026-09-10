import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit, verifySession, apiUnauthorized, apiSecretMissing } from "@/lib/request-guard"
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
    return apiUnauthorized()
  }
  const loginUrl = new URL("/login", clientBaseUrl(request))
  // Ursprüngliche URL merken damit nach Login direkt weitergeleitet wird
  const from = request.nextUrl.pathname + request.nextUrl.search
  if (from !== "/") {
    loginUrl.searchParams.set("from", from)
  }
  return NextResponse.redirect(loginUrl)
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

  const verdict = await verifySession(request)

  // SESSION_SECRET nicht gesetzt → App nicht nutzbar, zur Login-Seite
  if (verdict === "missing_secret") {
    if (pathname.startsWith("/api/")) return applyNonce(apiSecretMissing())
    return applyNonce(NextResponse.redirect(new URL("/login", clientBaseUrl(request))))
  }

  if (verdict === "unauthorized") {
    return applyNonce(redirectToLogin(request))
  }

  return applyNonce(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  // Middleware auf alle Routen außer Next.js-interne Assets anwenden.
  // map/ enthält nur statische Karten-Assets (MapLibre-Worker-Paar, Glyph-
  // Schriften) — ohne Ausnahme würde der Worker-Fetch je nach Credentials-
  // Modus auf /login umgeleitet und die Karte bliebe leer.
  // api/upload und api/import: Node-Middleware lässt Next den kompletten Body
  // vor dem Handler in den RAM klonen — die Routen streamen ihn selbst und
  // ziehen Session-Check + Rate-Limit über src/lib/request-guard.ts nach.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon\\.svg|manifest\\.webmanifest|sw\\.js|map/|api/upload$|api/import$).*)"],
}
