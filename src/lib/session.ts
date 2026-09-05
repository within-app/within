import type { SessionOptions } from "iron-session"

export interface SessionData {
  authenticated: boolean
  expiresAt: number
}

const maxAgeHours = parseInt(process.env.SESSION_MAX_AGE_HOURS ?? "24", 10)

export const SESSION_COOKIE_NAME = "mpj_session"

export const sessionOptions: SessionOptions = {
  cookieName: SESSION_COOKIE_NAME,
  // Falls SESSION_SECRET fehlt, wird der Login-Endpunkt mit 500 antworten —
  // dieser Fallback-String wird nur beim Build/Type-Check benötigt.
  password: process.env.SESSION_SECRET ?? "build-time-placeholder-not-used",
  cookieOptions: {
    // Secure-Flag wenn explizit aktiviert (SECURE_COOKIES=true) ODER die App
    // hinter einem TLS-Proxy läuft (TRUSTED_PROXY_COUNT>0) — die beiden
    // Flags waren entkoppelt; ein Self-Hoster hinter HTTPS-Proxy ohne
    // SECURE_COOKIES verschickte das Auth-Cookie auch über plain HTTP.
    // Standard bleibt false (LAN-HTTP-Health-Check auf :4000).
    secure:
      process.env.SECURE_COOKIES === "true" ||
      parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10) > 0,
    httpOnly: true,
    sameSite: "strict",
    maxAge: maxAgeHours * 60 * 60,
  },
}
