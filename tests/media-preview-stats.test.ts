/**
 * GET /api/media/preview-stats (Offline-Medienspiegel):
 * ehrliche Speicherplatz-Info für die Zeitraum-Einstellung — Anzahl + Bytes
 * der Server-Thumbnails (`*-thumb.webp`) von Fotos, deren Eintrag im
 * Zeitraum liegt (`created_at >= since`; ohne since: alle).
 *
 * Die media-Tabelle hat KEINE Größen-Spalten (`\d media`) —
 * die Route fs-stat'et die thumbnail_path-Dateien unter public/media. Die
 * Query wählt nur die kleine Spalte thumbnail_path (Pi-OOM-Regel).
 *
 * Nur synthetische Daten.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

vi.setConfig({ testTimeout: 20_000 })

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"
import { GET } from "../src/app/api/media/preview-stats/route"

// Reale synthetische Thumb-Dateien — die Route stat'et das Dateisystem.
const SYNTH_DIR = join(process.cwd(), "public", "media", "__vitest-preview-stats__")

beforeAll(() => {
  mkdirSync(SYNTH_DIR, { recursive: true })
  writeFileSync(join(SYNTH_DIR, "a-thumb.webp"), Buffer.alloc(1000, 0x01))
  writeFileSync(join(SYNTH_DIR, "b-thumb.webp"), Buffer.alloc(2500, 0x02))
})

afterAll(() => {
  rmSync(SYNTH_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  vi.mocked(db.query).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

function request(query = "") {
  return new NextRequest(`http://localhost/api/media/preview-stats${query}`)
}

describe("GET /api/media/preview-stats", () => {
  it("summiert count + bytes über fs-stat der thumbnail_path-Dateien", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { thumbnail_path: "/media/__vitest-preview-stats__/a-thumb.webp" },
        { thumbnail_path: "/media/__vitest-preview-stats__/b-thumb.webp" },
      ],
    } as never)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 2, bytes: 3500 })
  })

  it("reicht since als Parameter an die Query durch und filtert auf Zeitraum + Foto + Tombstone", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)
    const since = "2026-06-01T00:00:00.000Z"
    const res = await GET(request(`?since=${encodeURIComponent(since)}`))
    expect(res.status).toBe(200)
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toContain(since)
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i)
    expect(sql).toMatch(/type\s*=\s*'photo'/i)
    expect(sql).toMatch(/thumbnail_path\s+IS\s+NOT\s+NULL/i)
    // Pi-OOM-Regel: nur die kleine Pfad-Spalte, nie file_path-Fallbacks
    expect(sql).not.toMatch(/COALESCE/i)
    expect(sql).not.toMatch(/file_path/i)
  })

  it("ohne since: Query läuft ohne Zeitraum-Filter-Wert (NULL-Param)", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)
    const res = await GET(request())
    expect(res.status).toBe(200)
    const [, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([null])
  })

  it("ungültiges since → 400, keine DB-Query", async () => {
    const res = await GET(request("?since=gestern"))
    expect(res.status).toBe(400)
    expect(vi.mocked(db.query)).not.toHaveBeenCalled()
  })

  it("fehlende Datei auf Platte wird übersprungen (ehrliche Zahl, kein Fehler)", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { thumbnail_path: "/media/__vitest-preview-stats__/a-thumb.webp" },
        { thumbnail_path: "/media/__vitest-preview-stats__/missing-thumb.webp" },
      ],
    } as never)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 1, bytes: 1000 })
  })

  it("Pfad außerhalb von public/media wird nie gestattet (Traversal-Guard)", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ thumbnail_path: "/media/../../etc/passwd" }],
    } as never)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 0, bytes: 0 })
  })

  it("DB-Fehler in production → ehrliche 503, nie Mock-Daten", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(db.query).mockRejectedValue(new Error("connection refused"))
    const res = await GET(request())
    expect(res.status).toBe(503)
  })

  it("ohne DATABASE_URL in production → ehrliche 503", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DATABASE_URL", "")
    const res = await GET(request())
    expect(res.status).toBe(503)
  })

  it("antwortet private, no-store (§5.6 — Zahlen sind kein Journal-Inhalt, trotzdem nichts persistieren)", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)
    const res = await GET(request())
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })
})
