/**
 * GET /api/media liefert `clientMediaId` mit.
 *
 * Das Feld ist der einzige Schlüssel, der eine wartende Kachel mit ihrer
 * hochgeladenen Server-Zeile verbindet: `unmergedPending` verwirft darüber die
 * lokale Vorschau, wenn der Upload schon gelandet ist, der Outbox-Eintrag aber
 * noch existiert (App zwischen Upload-201 und deleteOutboxMedia
 * gestorben). Fällt es aus der Projektion, zeigt die Übersicht das Foto
 * doppelt, und keine E2E-Stufe merkt es: die dortige Prüfung wartet erst, bis
 * der Wartekorb leer ist, und hat dann nichts mehr zu deduplizieren.
 *
 * Mock-Test über den SQL-Text und die Mapping-Schicht (Muster
 * read-routes-tombstone-filter). Synthetische Daten.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.setConfig({ testTimeout: 20_000 })

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))

import { db } from "@/lib/db"

const ROW = {
  id: "m1",
  entry_id: "e1",
  type: "photo",
  file_path: "/media/j/m1.jpg",
  thumbnail_path: "/media/j/m1-thumb.webp",
  preview_path: null,
  duration_seconds: null,
  client_media_id: "outbox-42",
  created_at: "2026-09-04T10:00:00.000Z",
  journal_color: "#007AFF",
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  vi.mocked(db.query).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

async function callRoute() {
  const captured: string[] = []
  vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
    captured.push(sql as string)
    if (/COUNT\(\*\)::int AS total\b/.test(sql as string)) return { rows: [{ total: 1 }] }
    return { rows: [ROW] }
  })
  const { GET } = await import("../src/app/api/media/route")
  const res = await GET(new NextRequest("http://localhost/api/media"))
  return { body: await res.json(), captured }
}

describe("GET /api/media — clientMediaId", () => {
  it("wählt client_media_id in der Projektion aus", async () => {
    const { captured } = await callRoute()
    const select = captured.find((q) => /FROM media m/.test(q) && !/COUNT/.test(q))
    expect(select).toBeDefined()
    expect(select).toMatch(/m\.client_media_id/)
  })

  it("gibt den Wert als clientMediaId an den Client weiter", async () => {
    const { body } = await callRoute()
    expect(body.photos[0].clientMediaId).toBe("outbox-42")
  })

  it("liefert null statt undefined für Zeilen ohne Schlüssel (vor dem Idempotenz-Fix hochgeladen)", async () => {
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      if (/COUNT\(\*\)::int AS total\b/.test(sql as string)) return { rows: [{ total: 1 }] }
      return { rows: [{ ...ROW, client_media_id: null }] }
    })
    const { GET } = await import("../src/app/api/media/route")
    const res = await GET(new NextRequest("http://localhost/api/media"))
    const body = await res.json()
    expect(body.photos[0].clientMediaId).toBeNull()
  })
})
