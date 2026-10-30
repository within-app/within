/**
 * Import nimmt PDF-Anhänge mit (2026-10-30).
 *
 * Day One legt PDFs als `pdfAttachments` (identifier, md5, type "pdf",
 * pdfName, fileSize, orderInEntry) unter `pdfs/<md5>.pdf` ab und schreibt
 * `![](dayone-moment:/pdfAttachment/<ID>)` in den Text. Withins eigener
 * Export (v1) bekommt dafür `pdfs: [{filename, orderIndex, originalName,
 * sizeBytes}]` unter `pdfs/<entryId>/<filename>`.
 *
 * Red assertions (fail before implementation):
 *   1. Day One: PDF landet als media-Zeile type 'pdf' mit original_name =
 *      pdfName, size_bytes = Größe auf Platte, order_index = orderInEntry;
 *      der Text-Platzhalter ist entfernt
 *   2. Day One: Datei fehlt im ZIP → Hinweis, kein Insert
 *   3. Day One: Datei mit application/pdf-Namen, aber fremdem Inhalt → Hinweis,
 *      kein Insert, kein mkdir/rename (Header-Prüfung VOR dem Verschieben)
 *   4. v1: pdfs aus dem Manifest kommen zurück (Round-Trip)
 *   5. Reihenfolge folgt orderInEntry/orderIndex, nicht der JSON-Reihenfolge
 *
 * Synthetic data only — sharp, fs und der Header-Leser sind gemockt; der
 * Header-Befund kommt aus dem Dateinamen des Fixtures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/request-guard", () => ({ guardApiRequest: async () => null }))
vi.mock("@/lib/db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }))

const DISK_SIZE = 4096
vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: DISK_SIZE }),
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

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ format: "jpeg" }),
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Header-Befund aus dem Dateinamen: "…notpdf…" → HTML-Bytes, "…unreadable…" → Lesefehler.
const readFileHeadMock = vi.hoisted(() =>
  vi.fn(async (path: string) => {
    if (path.includes("unreadable")) throw new Error("EIO")
    if (path.includes("notpdf")) return new TextEncoder().encode("<!doc")
    return new TextEncoder().encode("%PDF-1.7\n")
  })
)
vi.mock("@/lib/upload-stream", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload-stream")>()),
  readFileHead: readFileHeadMock,
}))

// ── Synthetic test data ────────────────────────────────────────────────────

const JOURNAL_ID = "11111111-1111-4111-8111-111111111111"
const ENTRY_ID   = "22222222-2222-4222-8222-222222222222"
const DAYONE_UUID = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
const PDF_ID = "AABBCC001122334455AABBCC00112233"
const BLOB = new Uint8Array(64).fill(0xab)

interface DayOnePdfFixture {
  md5: string
  pdfName: string
  fileSize?: number
  orderInEntry?: number
  /** false → Datei fehlt im ZIP */
  present?: boolean
}

function buildDayOneZip(pdfs: DayOnePdfFixture[], text = `Rechnung ![](dayone-moment:/pdfAttachment/${PDF_ID}) anbei`): Uint8Array {
  const journal = {
    entries: [{
      uuid: DAYONE_UUID,
      text,
      creationDate: "2024-05-01T10:00:00Z",
      pdfAttachments: pdfs.map((p, i) => ({
        identifier: i === 0 ? PDF_ID : `${PDF_ID}${i}`,
        md5: p.md5,
        type: "pdf",
        pdfName: p.pdfName,
        fileSize: p.fileSize ?? 819175,
        orderInEntry: p.orderInEntry ?? i,
        favorite: false,
      })),
    }],
  }
  const files: Record<string, Uint8Array> = { "Tagebuch.json": strToU8(JSON.stringify(journal)) }
  for (const p of pdfs) if (p.present !== false) files[`pdfs/${p.md5}.pdf`] = BLOB
  return zipSync(files)
}

function buildV1Zip(pdfs: { filename: string; orderIndex?: number; originalName?: string | null; sizeBytes?: number | null }[]): Uint8Array {
  const exportData = {
    version: "1.0",
    exportedAt: "2024-06-01T10:00:00.000Z",
    journals: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }],
    entries: [{
      id: ENTRY_ID, journalId: JOURNAL_ID, text: "Synthetic entry",
      createdAt: "2024-06-01T08:00:00.000Z", updatedAt: "2024-06-01T09:00:00.000Z",
      pdfs,
    }],
  }
  const files: Record<string, Uint8Array> = { "export.json": strToU8(JSON.stringify(exportData)) }
  for (const p of pdfs) files[`pdfs/${ENTRY_ID}/${p.filename}`] = BLOB
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

describe("POST /api/import — PDF-Anhänge", () => {
  let capturedQueries: Array<{ sql: string; params?: unknown[] }>

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    capturedQueries = []
    vi.clearAllMocks()

    const { db } = await import("@/lib/db")
    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedQueries.push({ sql: sql.trim(), params })
        if (sql.includes("INSERT INTO entries")) return { rows: [], rowCount: 1 }
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

  function pdfInsert() {
    return capturedQueries.find(q => q.sql.includes("INSERT INTO media") && q.sql.includes("'pdf'"))
  }
  function entryInsert() {
    return capturedQueries.find(q => q.sql.includes("INSERT INTO entries"))
  }

  // ── Day One ───────────────────────────────────────────────────────────────

  it("Day One: pdfAttachments → media type 'pdf' mit Name, Größe von Platte und Reihenfolge; Text-Platzhalter entfernt", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "ff69b184d8f8325909c7adb5cdce33d9"
    const res = await POST(makeImportRequest(buildDayOneZip([{ md5, pdfName: "Synth Rechnung.pdf", fileSize: 819175, orderInEntry: 3 }])))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings ?? []).toHaveLength(0)

    const ins = pdfInsert()
    expect(ins).toBeDefined()
    expect(ins!.sql).toMatch(/original_name/)
    expect(ins!.sql).toMatch(/size_bytes/)
    const params = ins!.params as unknown[]
    const filePaths = params.find(p => Array.isArray(p) && typeof p[0] === "string" && String(p[0]).startsWith("/media/")) as string[]
    expect(filePaths).toHaveLength(1)
    expect(filePaths[0]).toMatch(/^\/media\/[0-9a-f-]+\/[0-9a-f-]+-original\.pdf$/)
    expect(params).toContainEqual(["Synth Rechnung.pdf"])
    expect(params).toContainEqual([DISK_SIZE])
    expect(params).toContainEqual([3])

    // Header gelesen, Datei in ihr Medienverzeichnis verschoben
    expect(readFileHeadMock).toHaveBeenCalledTimes(1)
    const fsp = await import("fs/promises")
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledTimes(1)

    // Der Day-One-Platzhalter steht nicht mehr im Text
    const text = String((entryInsert()!.params as unknown[])[2])
    expect(text).not.toContain("dayone-moment")
    expect(text).toBe("Rechnung  anbei")
  })

  it("Day One: Datei fehlt im ZIP → Hinweis mit Pfad, kein Insert, Eintrag kommt trotzdem an", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "0123456789abcdef0123456789abcdef"
    const res = await POST(makeImportRequest(buildDayOneZip([{ md5, pdfName: "weg.pdf", present: false }])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`pdfs/${md5}.pdf`)
    expect(pdfInsert()).toBeUndefined()
  })

  it("Day One: Datei ohne PDF-Kopf → Hinweis, kein Insert, nichts verschoben (Prüfung vor mkdir/rename)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "notpdf00000000000000000000000000"
    const res = await POST(makeImportRequest(buildDayOneZip([{ md5, pdfName: "getarnt.pdf" }])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`pdfs/${md5}.pdf`)
    expect(pdfInsert()).toBeUndefined()
    const fsp = await import("fs/promises")
    expect(vi.mocked(fsp.mkdir)).not.toHaveBeenCalled()
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled()
  })

  it("Day One: Lesefehler am Kopf zählt wie ein fremder Inhalt (fail-closed)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "unreadable0000000000000000000000"
    const res = await POST(makeImportRequest(buildDayOneZip([{ md5, pdfName: "kaputt.pdf" }])))
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.warnings).toHaveLength(1)
    expect(pdfInsert()).toBeUndefined()
  })

  it("Day One: Reihenfolge folgt orderInEntry, nicht der JSON-Reihenfolge", async () => {
    const { POST } = await import("../src/app/api/import/route")
    await POST(makeImportRequest(buildDayOneZip([
      { md5: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", pdfName: "zweites.pdf", orderInEntry: 1 },
      { md5: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", pdfName: "erstes.pdf", orderInEntry: 0 },
    ])))
    const params = pdfInsert()!.params as unknown[]
    expect(params).toContainEqual(["erstes.pdf", "zweites.pdf"])
    expect(params).toContainEqual([0, 1])
  })

  it("Day One: pdfName mit Pfad-/Steuerzeichen wird bereinigt gespeichert, nie roh", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
    await POST(makeImportRequest(buildDayOneZip([{ md5, pdfName: "..\\..\\x\u0000.pdf" }])))
    const params = pdfInsert()!.params as unknown[]
    expect(params).toContainEqual(["x.pdf"])
    expect(JSON.stringify(params)).not.toContain("\\u0000")
  })

  it("Day One: pdfName über 200 Zeichen wird gekappt, leerer Name wird null", async () => {
    const { POST } = await import("../src/app/api/import/route")
    await POST(makeImportRequest(buildDayOneZip([
      { md5: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4", pdfName: "x".repeat(300) + ".pdf", orderInEntry: 0 },
      { md5: "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5", pdfName: "   ", orderInEntry: 1 },
    ])))
    const params = pdfInsert()!.params as unknown[]
    const names = params.find(p => Array.isArray(p) && p.length === 2 && (p[0] === null || typeof p[0] === "string") && String(p[0]).length > 100) as (string | null)[]
    expect(names[0]).toHaveLength(200)
    expect(names[1]).toBeNull()
  })

  it("Day One: type ≠ pdf → der Lookup folgt dem Typ, aber der Inhalt entscheidet (Header), nie der Name", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const md5 = "notpdf6f6f6f6f6f6f6f6f6f6f6f6f6f"
    const journal = {
      entries: [{
        uuid: DAYONE_UUID, text: "x", creationDate: "2024-05-01T10:00:00Z",
        pdfAttachments: [{ identifier: PDF_ID, md5, type: "html", pdfName: "evil.pdf", orderInEntry: 0 }],
      }],
    }
    const zip = zipSync({ "Tagebuch.json": strToU8(JSON.stringify(journal)), [`pdfs/${md5}.html`]: BLOB })
    const res = await POST(makeImportRequest(zip))
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    // Die Datei liegt zwar im ZIP, aber ihr Inhalt ist kein PDF → übersprungen
    expect(body.warnings).toHaveLength(1)
    expect(pdfInsert()).toBeUndefined()
  })

  // ── Within v1 (Round-Trip) ────────────────────────────────────────────────

  it("v1: pdfs aus dem Manifest werden mit originalName/orderIndex übernommen, Größe von Platte", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip([
      { filename: `${ENTRY_ID}-original.pdf`, orderIndex: 5, originalName: "Round Trip.pdf", sizeBytes: 999 },
    ])))
    const body = (await res.json()) as ImportResult
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)
    expect(body.warnings ?? []).toHaveLength(0)

    const ins = pdfInsert()
    expect(ins).toBeDefined()
    const params = ins!.params as unknown[]
    expect(params).toContainEqual(["Round Trip.pdf"])
    expect(params).toContainEqual([DISK_SIZE])
    expect(params).toContainEqual([5])
    const filePaths = params.find(p => Array.isArray(p) && typeof p[0] === "string" && String(p[0]).startsWith("/media/")) as string[]
    expect(filePaths[0]).toMatch(/-original\.pdf$/)
  })

  it("v1: Datei fehlt im ZIP → Hinweis mit Pfad, kein Insert", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const exportData = {
      version: "1.0", exportedAt: "2024-06-01T10:00:00.000Z",
      journals: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }],
      entries: [{ id: ENTRY_ID, journalId: JOURNAL_ID, text: "Synthetic entry",
        createdAt: "2024-06-01T08:00:00.000Z", updatedAt: "2024-06-01T09:00:00.000Z",
        pdfs: [{ filename: "weg-original.pdf", orderIndex: 0 }] }],
    }
    const res = await POST(makeImportRequest(zipSync({ "export.json": strToU8(JSON.stringify(exportData)) })))
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`pdfs/${ENTRY_ID}/weg-original.pdf`)
    expect(pdfInsert()).toBeUndefined()
  })

  it("v1: Datei ohne PDF-Kopf wird übersprungen und gemeldet", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip([{ filename: "notpdf-original.pdf", orderIndex: 0 }])))
    const body = (await res.json()) as ImportResult
    expect(body.imported).toBe(1)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings![0]).toContain(`pdfs/${ENTRY_ID}/notpdf-original.pdf`)
    expect(pdfInsert()).toBeUndefined()
  })
})
