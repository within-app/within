/**
 * ZIP-Import prüft Bildformate wie der Upload (Trust-Boundary, Audit 10.09.2026)
 *
 * Der Upload liest mit sharp(path).metadata() nur den Header und lässt nur
 * jpeg/png/webp/gif zu (safeExtFromFormat). Der Import übernahm bisher die
 * Endung aus dem Dateinamen und dekodierte sofort — jedes Format, das libvips
 * kennt (AVIF/HEIC via libheif). Hier: dieselbe Allowlist vor jedem Decode.
 *
 * Red assertions (fail before implementation):
 *   1. Erlaubte Formate (PNG/JPEG/WebP/GIF) kommen wie bisher an — Endung aus
 *      dem erkannten Format, nicht aus dem Dateinamen
 *   2. ".jpg"-Datei mit HEIF-Inhalt → übersprungen, gemeldet, keine Decode-Pipeline
 *   3. Mischung → nur erlaubte Dateien, Zähler stimmen (v1- und DayOne-Pfad)
 *
 * Synthetic data only — sharp und fs sind gemockt, das Format kommt aus dem
 * Dateinamen des Fixtures (steht für den Header-Befund von metadata()).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/request-guard", () => ({ guardApiRequest: async () => null }))
vi.mock("@/lib/db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }))

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs", () => {
  function makeFakeWriteStream() {
    const cbs: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      once(ev: string, cb: (...a: unknown[]) => void) { (cbs[ev] ??= []).push(cb); return this },
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(function () { ;(cbs["finish"] ?? []).forEach(fn => fn()) }),
      destroy: vi.fn(function () { ;(cbs["error"] ?? []).forEach(fn => fn(new Error("destroyed"))) }),
    }
  }
  return { mkdirSync: vi.fn(), createWriteStream: vi.fn(() => makeFakeWriteStream()) }
})

// Eine geteilte Pipeline, damit die Tests belegen können, dass .rotate()/.resize()
// für abgelehnte Dateien nie erreicht wird. metadata() liefert das Format, das
// der Fixture-Name ankündigt ("...heif-as.jpg" → "heif" wie AVIF/HEIC bei sharp).
const sharpMock = vi.hoisted(() => {
  const pipeline = {
    metadata: vi.fn(),
    rotate: vi.fn(),
    resize: vi.fn(),
    webp: vi.fn(),
    toFile: vi.fn(),
  }
  pipeline.rotate.mockReturnValue(pipeline)
  pipeline.resize.mockReturnValue(pipeline)
  pipeline.webp.mockReturnValue(pipeline)
  pipeline.toFile.mockResolvedValue(undefined)
  const formatFor = (path: string): string | undefined => {
    const m = /(heif|tiff|png|webp|gif|jpeg|garbage)-as\./.exec(path)
    if (!m) return "jpeg"
    return m[1] === "garbage" ? undefined : m[1]
  }
  const sharp = vi.fn((path: string) => {
    if (path.includes("-throw-as.")) {
      pipeline.metadata.mockRejectedValue(new Error("Input file has corrupt header"))
    } else {
      pipeline.metadata.mockResolvedValue({ format: formatFor(path) })
    }
    return pipeline
  })
  return { sharp, pipeline }
})

vi.mock("sharp", () => ({ default: sharpMock.sharp }))

// ── Synthetic test data ────────────────────────────────────────────────────

const JOURNAL_ID = "11111111-1111-4111-8111-111111111111"
const ENTRY_ID   = "22222222-2222-4222-8222-222222222222"
const BLOB = new Uint8Array(64).fill(0xab)

function buildV1Zip(filenames: string[]): Uint8Array {
  const exportData = {
    version: "1.0",
    exportedAt: "2024-06-01T10:00:00.000Z",
    journals: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }],
    entries: [{
      id: ENTRY_ID, journalId: JOURNAL_ID, text: "Synthetic entry",
      createdAt: "2024-06-01T08:00:00.000Z", updatedAt: "2024-06-01T09:00:00.000Z",
      photos: filenames.map((filename, orderIndex) => ({ filename, orderIndex })),
    }],
  }
  const files: Record<string, Uint8Array> = { "export.json": strToU8(JSON.stringify(exportData)) }
  for (const f of filenames) files[`photos/${ENTRY_ID}/${f}`] = BLOB
  return zipSync(files)
}

function buildDayOneZip(photos: { md5: string; type: string }[]): Uint8Array {
  const journal = {
    entries: [{
      uuid: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      text: "Synthetic DayOne entry",
      creationDate: "2024-05-01T10:00:00Z",
      photos: photos.map((p, i) => ({ identifier: `p${i}`, md5: p.md5, type: p.type, orderInEntry: i })),
    }],
  }
  const files: Record<string, Uint8Array> = { "Journal.json": strToU8(JSON.stringify(journal)) }
  for (const p of photos) files[`photos/${p.md5}.${p.type}`] = BLOB
  return zipSync(files)
}

function makeImportRequest(body: Uint8Array): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/import"), {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: body as unknown as BodyInit,
  })
}

type ImportResult = { imported: number; skipped: number; errors: string[]; warnings?: string[] }

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/import — Bild-Allowlist wie im Upload", () => {
  let capturedQueries: Array<{ sql: string; params?: unknown[] }>

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    capturedQueries = []
    vi.clearAllMocks()

    const { db } = await import("@/lib/db")
    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedQueries.push({ sql: sql.trim(), params })
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql: sql.trim(), params })
      const s = sql.trim()
      if (s.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
      if (s.includes("INSERT INTO journals")) return { rows: [{ id: JOURNAL_ID }] }
      if (s.includes("SELECT id FROM journals WHERE id")) return { rows: [{ id: JOURNAL_ID }] }
      return { rows: [] }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function photoInsert() {
    return capturedQueries.find(q => q.sql.includes("INSERT INTO media") && q.sql.includes("'photo'"))
  }

  // ── (a) erlaubte Formate ──────────────────────────────────────────────────

  it("importiert PNG/JPEG/WebP/GIF wie bisher — Endung aus dem erkannten Format", async () => {
    const { POST } = await import("../src/app/api/import/route")
    // Der Dateiname lügt bewusst (".jpg" für alle), der Header sagt die Wahrheit.
    const res = await POST(makeImportRequest(buildV1Zip([
      "a-png-as.jpg", "b-jpeg-as.jpg", "c-webp-as.jpg", "d-gif-as.jpg",
    ])))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings ?? []).toHaveLength(0)

    const filePaths = photoInsert()!.params![1] as string[]
    expect(filePaths).toHaveLength(4)
    expect(filePaths.map(p => p.split(".").pop())).toEqual(["png", "jpg", "webp", "gif"])
    expect(sharpMock.pipeline.toFile).toHaveBeenCalledTimes(4)
  })

  // ── (b) getarnte Datei ────────────────────────────────────────────────────

  it("überspringt eine .jpg-Datei mit HEIF-Inhalt ohne sie zu dekodieren", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip(["evil-heif-as.jpg"])))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ImportResult

    // Eintrag kommt an, das Bild nicht — und der Nutzer erfährt es.
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`photos/${ENTRY_ID}/evil-heif-as.jpg`)
    expect(photoInsert()).toBeUndefined()

    // Header wurde gelesen, die Decode-Pipeline nie betreten.
    expect(sharpMock.pipeline.metadata).toHaveBeenCalledTimes(1)
    expect(sharpMock.pipeline.rotate).not.toHaveBeenCalled()
    expect(sharpMock.pipeline.resize).not.toHaveBeenCalled()
    expect(sharpMock.pipeline.toFile).not.toHaveBeenCalled()
    // Nichts wurde nach public/media/<uuid>/ verschoben.
    const fsp = await import("fs/promises")
    expect(vi.mocked(fsp.mkdir)).not.toHaveBeenCalled()
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled()
  })

  it("überspringt eine Datei, bei der metadata() wirft (korrupter Header)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip(["broken-throw-as.jpg"])))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`photos/${ENTRY_ID}/broken-throw-as.jpg`)
    expect(photoInsert()).toBeUndefined()
    expect(sharpMock.pipeline.metadata).toHaveBeenCalledTimes(1)
    expect(sharpMock.pipeline.rotate).not.toHaveBeenCalled()
    expect(sharpMock.pipeline.resize).not.toHaveBeenCalled()
    expect(sharpMock.pipeline.toFile).not.toHaveBeenCalled()
    const fsp = await import("fs/promises")
    expect(vi.mocked(fsp.mkdir)).not.toHaveBeenCalled()
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled()
  })

  it("überspringt auch TIFF und Nicht-Bilder (metadata ohne Format)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip(["x-tiff-as.jpg", "y-garbage-as.jpg"])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.warnings).toHaveLength(2)
    expect(photoInsert()).toBeUndefined()
    expect(sharpMock.pipeline.rotate).not.toHaveBeenCalled()
  })

  // ── (c) Mischung, beide Import-Pfade ──────────────────────────────────────

  it("v1-ZIP mit Mischung: nur erlaubte Bilder kommen an, Zähler stimmen", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip([
      "ok-jpeg-as.jpg", "bad-heif-as.jpg", "ok-png-as.png", "bad-tiff-as.jpg", "ok-webp-as.webp",
    ])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.skipped).toBe(0)
    expect(body.warnings).toHaveLength(2)

    const filePaths = photoInsert()!.params![1] as string[]
    expect(filePaths).toHaveLength(3)
    expect(filePaths.map(p => p.split(".").pop())).toEqual(["jpg", "png", "webp"])
    expect(sharpMock.pipeline.metadata).toHaveBeenCalledTimes(5)
    expect(sharpMock.pipeline.toFile).toHaveBeenCalledTimes(3)
  })

  it("DayOne-ZIP mit Mischung: type 'jpeg' im JSON schützt nicht — der Header zählt", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildDayOneZip([
      { md5: "aaa-jpeg-as", type: "jpeg" },
      { md5: "bbb-heif-as", type: "jpeg" },
      { md5: "ccc-gif-as",  type: "gif" },
    ])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain("photos/bbb-heif-as.jpeg")

    const filePaths = photoInsert()!.params![1] as string[]
    expect(filePaths).toHaveLength(2)
    expect(filePaths.map(p => p.split(".").pop())).toEqual(["jpg", "gif"])
    expect(sharpMock.pipeline.toFile).toHaveBeenCalledTimes(2)
  })
})
