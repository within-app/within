import { NextRequest, NextResponse } from "next/server"
import { getIronSession } from "iron-session"
import { cookies } from "next/headers"
import bcrypt from "bcryptjs"
import type { SessionData } from "@/lib/session"
import { sessionOptions } from "@/lib/session"
import { getPasswordHash } from "@/lib/password"

const BODY_LIMIT = 10_000

// Read the request body stream, counting bytes. Returns the raw text when the
// body fits within `limit`, or null when it exceeds it. This replaces the old
// Content-Length header check, which Transfer-Encoding: chunked requests omit
// (Content-Length defaults to 0, bypassing the guard).
async function readBodyWithLimit(
  req: NextRequest,
  limit: number,
): Promise<string | null> {
  // Fast-path: reject immediately when Content-Length is present and large.
  const cl = Number(req.headers.get("content-length") ?? "-1")
  if (cl > limit) return null

  const reader = req.body?.getReader()
  if (!reader) return ""

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > limit) {
        reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export async function POST(req: NextRequest) {
  // Hash aus der Datenbank (APP_PASSWORD beim Start gehasht) oder Rückfall
  // APP_PASSWORD_HASH aus der Umgebung — siehe src/lib/password.ts.
  const passwordHash = await getPasswordHash().catch(() => null)
  if (!passwordHash) {
    return NextResponse.json(
      { error: "APP_PASSWORD ist nicht konfiguriert. Bitte docker-compose.yml prüfen.", code: "config_password_hash_missing" },
      { status: 500 }
    )
  }

  if (!process.env.SESSION_SECRET) {
    return NextResponse.json(
      { error: "SESSION_SECRET ist nicht konfiguriert. Bitte .env Datei prüfen.", code: "config_session_secret_missing" },
      { status: 500 }
    )
  }

  // Reject oversized bodies before parsing — a password payload is never more
  // than a few hundred bytes. Counts actual stream bytes so Transfer-Encoding:
  // chunked requests (no Content-Length header) are also caught.
  const rawBody = await readBodyWithLimit(req, BODY_LIMIT)
  if (rawBody === null) {
    return NextResponse.json({ error: "Anfrage zu groß", code: "request_too_large" }, { status: 413 })
  }

  let body: { password?: string }
  try {
    body = JSON.parse(rawBody || "{}") as { password?: string }
  } catch {
    body = {}
  }
  const { password } = body

  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Passwort ist erforderlich", code: "password_required" }, { status: 400 })
  }

  const isValid = await bcrypt.compare(password, passwordHash)

  if (!isValid) {
    // Gleiche Antwortzeit wie bei gültigem Passwort (verhindert Timing-Angriffe)
    return NextResponse.json({ error: "Falsches Passwort", code: "wrong_password" }, { status: 401 })
  }

  const maxAgeHours = parseInt(process.env.SESSION_MAX_AGE_HOURS ?? "24", 10)
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
  session.authenticated = true
  session.expiresAt = Date.now() + maxAgeHours * 60 * 60 * 1000
  await session.save()

  return NextResponse.json({ ok: true })
}
