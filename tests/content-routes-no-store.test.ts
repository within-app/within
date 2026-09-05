/**
 * HTTP-Cache-Leck (Gerätetest §2): Die Medien-Route lieferte
 * `Cache-Control: public, max-age=31536000, immutable` — jedes online
 * angesehene Foto lag damit bis zu einem Jahr UNVERSCHLÜSSELT im Disk-Cache
 * des Browsers und unterlief den verschlüsselten Pin-Cache, der
 * vom HTTP-Cache schlicht überdeckt wurde. Journal-INHALT darf der Browser
 * nie persistieren: Medien (Fotos/Thumbnails/Previews laufen alle über
 * /media/) und Export-ZIPs antworten `private, no-store`.
 *
 * Statische Assets (_next/static, icons, fonts, map) bleiben cachebar —
 * sie enthalten keinen Inhalt und laufen nicht über diese Routen.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { NextRequest } from "next/server"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"
import { GET as mediaGET } from "../src/app/media/[...path]/route"
import { GET as exportGET } from "../src/app/api/export/route"
import { GET as exportByIdGET } from "../src/app/api/export/[id]/route"
import { GET as previewStatsGET } from "../src/app/api/media/preview-stats/route"

const NO_STORE = "private, no-store"

// Die Medien-Route liest real aus public/media (MEDIA_BASE wird beim
// Modul-Load aus process.cwd() aufgelöst) — synthetische Dateien dort
// ablegen und wieder entfernen.
const SYNTH_DIR = join(process.cwd(), "public", "media", "__vitest-no-store__")

beforeAll(() => {
  mkdirSync(SYNTH_DIR, { recursive: true })
  writeFileSync(join(SYNTH_DIR, "synth.jpg"), Buffer.from("SYNTHETIC_JPEG_NOT_REAL"))
  writeFileSync(join(SYNTH_DIR, "synth.mp4"), Buffer.alloc(4096, 0xab))
})

afterAll(() => {
  rmSync(SYNTH_DIR, { recursive: true, force: true })
})

function mediaParams(...path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe("Medien-Route: Cache-Control private, no-store (HTTP-Cache-Leck)", () => {
  it("200-Vollantwort (Foto) trägt private, no-store — nie public/immutable", async () => {
    const res = await mediaGET(
      new NextRequest("http://localhost/media/__vitest-no-store__/synth.jpg"),
      mediaParams("__vitest-no-store__", "synth.jpg")
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(NO_STORE)
  })

  it("206-Range-Antwort (Video-Seek) trägt private, no-store — nie public/immutable", async () => {
    const req = new NextRequest("http://localhost/media/__vitest-no-store__/synth.mp4", {
      headers: { range: "bytes=0-1023" },
    })
    const res = await mediaGET(req, mediaParams("__vitest-no-store__", "synth.mp4"))
    expect(res.status).toBe(206)
    expect(res.headers.get("cache-control")).toBe(NO_STORE)
  })
})

describe("next.config: /media/ auch am STATIC-Layer no-store (E2E-Befund)", () => {
  // Medien liegen unter public/media — je nach Server-Generation bedient
  // Nexts statische public/-Auslieferung den Request und der Route-Handler
  // läuft NIE (beobachtet: `public, max-age=0` + ETag im echten Chromium,
  // während curl auf derselben URL die Route mit no-store traf). Der Header
  // muss deshalb zusätzlich zentral in next.config gesetzt werden — derselbe
  // Mechanismus, mit dem /sw.js seine no-cache-Header bekommt (produktiv
  // bewiesen: der SW-Update-Fluss hängt daran).
  it("headers() enthält eine /media/:path*-Regel mit private, no-store", async () => {
    const config = (await import("../next.config")).default
    const rules = await config.headers!()
    const mediaRule = rules.find((r) => r.source === "/media/:path*")
    expect(mediaRule).toBeDefined()
    expect(mediaRule!.headers).toContainEqual({ key: "Cache-Control", value: "private, no-store" })
  })
})

describe("Export-Routen: Cache-Control private, no-store (kompletter Journal-Inhalt als ZIP)", () => {
  it("GET /api/export antwortet private, no-store", async () => {
    process.env.DATABASE_URL = "postgres://synthetic:synthetic@localhost:5432/synthetic"
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)

    const res = await exportGET(new NextRequest("http://localhost/api/export"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(NO_STORE)
  })

  it("GET /api/export/[id] antwortet private, no-store", async () => {
    process.env.DATABASE_URL = "postgres://synthetic:synthetic@localhost:5432/synthetic"
    const entryRow = {
      id: "20000000-0000-4000-8000-000000000001",
      journal_id: "10000000-0000-4000-8000-000000000001",
      text: "Synthetic export entry",
      created_at: new Date("2026-06-01T10:00:00.000Z"),
      updated_at: new Date("2026-06-01T10:00:00.000Z"),
      starred: false,
      location_name: null,
      location_lat: null,
      location_lng: null,
      weather_description: null,
      weather_temp_celsius: null,
      weather_icon: null,
      journal_name: "QA-Synthetic",
      journal_color: "#007AFF",
    }
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [entryRow] } as never) // Entry
      .mockResolvedValue({ rows: [] } as never) // Media, Tags

    const res = await exportByIdGET(
      new NextRequest("http://localhost/api/export/20000000-0000-4000-8000-000000000001"),
      { params: Promise.resolve({ id: "20000000-0000-4000-8000-000000000001" }) }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(NO_STORE)
  })
})

describe("Preview-Stats-Route: Cache-Control private, no-store (Zahlen, kein Inhalt, trotzdem nichts persistieren)", () => {
  it("GET /api/media/preview-stats antwortet private, no-store", async () => {
    process.env.DATABASE_URL = "postgres://synthetic:synthetic@localhost:5432/synthetic"
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)

    const res = await previewStatsGET(new NextRequest("http://localhost/api/media/preview-stats"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(NO_STORE)
  })
})
