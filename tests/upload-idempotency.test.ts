/**
 * POST /api/upload: Idempotenzschlüssel + keine
 * Waisen-Dateien.
 *
 * Ein Retry nach verlorener Antwort (Funkloch, App-Kill zwischen
 * Response und Outbox-Delete) darf keine zweite media-Zeile erzeugen — der
 * Client schickt die Outbox-Id als `clientMediaId` mit, der Server erkennt
 * die bestehende Zeile über `media.client_media_id` (UNIQUE).
 *
 * Mit gesetztem entryId wird die Existenz des Eintrags geprüft, BEVOR
 * Bytes auf die Platte gehen — sonst stapelt jeder Retry eine unreferenzierte
 * Full-res-Kopie auf der Pi-Platte.
 *
 * Audio-Uploads als Vehikel: gleicher insertMediaRow-Pfad wie Fotos, aber ohne
 * sharp-Abhängigkeit. Synthetische Daten, keine echten Journal-Inhalte.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ── Mocks (must precede dynamic imports) ───────────────────────────────────────

const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockWriteFile = vi.fn().mockResolvedValue(undefined)
const mockRm = vi.fn().mockResolvedValue(undefined)
vi.mock("fs/promises", () => ({ mkdir: mockMkdir, writeFile: mockWriteFile, rm: mockRm }))

const mockSaveFileToDisk = vi.fn().mockResolvedValue(undefined)
vi.mock("@/lib/upload-stream", () => ({ saveFileToDisk: mockSaveFileToDisk }))

vi.mock("@/lib/video-thumbnail", () => ({
  extractPoster: vi.fn().mockResolvedValue(null),
  generateLoopClip: vi.fn(),
  probeDuration: vi.fn().mockResolvedValue(30),
  probeMediaStreams: vi.fn().mockResolvedValue("valid"),
}))

const mockDbQuery = vi.fn()
vi.mock("@/lib/db", () => ({ db: { query: mockDbQuery } }))

vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

process.env.DATABASE_URL = "postgresql://fake/test"

const { POST } = await import("@/app/api/upload/route")

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTRY_ID = "20000000-0000-4000-8000-000000000001"
const CLIENT_MEDIA_ID = "50000000-0000-4000-8000-000000000001"
const EXISTING_MEDIA_ID = "40000000-0000-4000-8000-000000000001"

function makeUploadReq(opts: { entryId?: string; clientMediaId?: string } = {}) {
  const url = `http://localhost/api/upload${opts.entryId ? `?entryId=${opts.entryId}` : ""}`
  const req = new NextRequest(url, { method: "POST" })

  const mockFile = {
    type: "audio/mpeg",
    size: 512 * 1024,
    name: "synthetic-audio",
    stream: () => new ReadableStream<Uint8Array>(),
    arrayBuffer: async () => new ArrayBuffer(0),
  }

  vi.spyOn(req, "formData").mockResolvedValue({
    get: (key: string) => {
      if (key === "file") return mockFile
      if (key === "clientMediaId") return opts.clientMediaId ?? null
      return null
    },
  } as unknown as FormData)

  return req
}

/**
 * SQL-dispatchender DB-Mock: antwortet nach Query-Inhalt statt Aufruf-
 * Reihenfolge, damit die Tests den echten Kontrollfluss der Route treffen.
 */
function seedDb(opts: {
  /** Zeile, die der client_media_id-Lookup liefert (Pre-Check UND Konflikt-Nachschlag). */
  existingByClientId?: { id: string; type?: string; file_path?: string; thumbnail_path?: string | null } | null
  /** Eintragszeile; null = Eintrag existiert nicht. */
  entryRow?: { deleted_at: string | null } | null
  /** rows-Ergebnis des INSERT; [] simuliert ON-CONFLICT-DO-NOTHING. */
  insertRows?: Array<{ id: string }>
  /** Läßt den INSERT mit diesem Fehler scheitern. */
  insertError?: Error & { code?: string }
  /** Läßt die Pre-Checks scheitern (transienter DB-Ausfall). */
  preCheckError?: Error
} = {}) {
  const {
    existingByClientId = null,
    entryRow = { deleted_at: null },
    insertRows = [{ id: "60000000-0000-4000-8000-000000000001" }],
    insertError,
    preCheckError,
  } = opts
  mockDbQuery.mockImplementation(async (sql: string) => {
    // Reihenfolge wichtig: der INSERT enthält selbst "client_media_id"
    // (ON-CONFLICT-Klausel) und muss vor dem Lookup-Matcher geprüft werden.
    if (sql.includes("INSERT INTO media")) {
      if (insertError) throw insertError
      return { rows: insertRows }
    }
    if (sql.includes("FROM media WHERE client_media_id")) {
      if (preCheckError) throw preCheckError
      return { rows: existingByClientId ? [existingByClientId] : [] }
    }
    if (sql.includes("FROM entries")) {
      if (preCheckError) throw preCheckError
      return { rows: entryRow ? [entryRow] : [] }
    }
    if (sql.includes("MAX(order_index)")) return { rows: [{ max_order: -1 }] }
    return { rows: [] }
  })
}

function insertCalls() {
  return mockDbQuery.mock.calls.filter(
    ([sql]: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO media")
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Idempotenz ─────────────────────────────────────────────────────────

describe("upload route — Idempotenzschlüssel", () => {
  it("Retry mit bekanntem clientMediaId liefert die bestehende Zeile — kein zweiter INSERT, keine Datei", async () => {
    seedDb({
      existingByClientId: {
        id: EXISTING_MEDIA_ID,
        type: "audio",
        file_path: "/media/synth/existing.mp3",
        thumbnail_path: null,
      },
    })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID, clientMediaId: CLIENT_MEDIA_ID }))

    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; filePath: string }
    expect(body.id).toBe(EXISTING_MEDIA_ID)
    expect(body.filePath).toBe("/media/synth/existing.mp3")
    expect(insertCalls()).toHaveLength(0)
    expect(mockMkdir).not.toHaveBeenCalled()
    expect(mockSaveFileToDisk).not.toHaveBeenCalled()
  })

  it("Erst-Upload schreibt clientMediaId als INSERT-Parameter mit", async () => {
    seedDb()

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID, clientMediaId: CLIENT_MEDIA_ID }))

    expect(res.status).toBe(201)
    const [insert] = insertCalls()
    expect(insert).toBeDefined()
    expect(insert[0] as string).toContain("client_media_id")
    expect(insert[1] as unknown[]).toContain(CLIENT_MEDIA_ID)
  })

  it("ohne clientMediaId bleibt das Verhalten unverändert (Parameter NULL)", async () => {
    seedDb()

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID }))

    expect(res.status).toBe(201)
    const [insert] = insertCalls()
    expect((insert[1] as unknown[]).at(-1)).toBeNull()
  })

  it("missgeformter clientMediaId wird ignoriert statt in die DB geschrieben", async () => {
    seedDb()

    await POST(makeUploadReq({ entryId: ENTRY_ID, clientMediaId: "x".repeat(200) }))

    const [insert] = insertCalls()
    expect((insert[1] as unknown[]).at(-1)).toBeNull()
  })

  it("verlorenes ON-CONFLICT-Rennen: Gewinner-Zeile wird geliefert, eigene Dateien entfernt", async () => {
    seedDb({ insertRows: [] })
    // Erst-Lookup leer (Pre-Check), Nachschlag nach dem Konflikt findet den Gewinner:
    let clientIdLookups = 0
    const impl = mockDbQuery.getMockImplementation()!
    mockDbQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM media WHERE client_media_id")) {
        clientIdLookups++
        return clientIdLookups === 1
          ? { rows: [] }
          : { rows: [{ id: EXISTING_MEDIA_ID, file_path: "/media/synth/winner.mp3", thumbnail_path: null }] }
      }
      return impl(sql, params)
    })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID, clientMediaId: CLIENT_MEDIA_ID }))

    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; filePath: string }
    expect(body.id).toBe(EXISTING_MEDIA_ID)
    expect(body.filePath).toBe("/media/synth/winner.mp3")
    expect(mockRm).toHaveBeenCalledOnce()
  })
})

// ── Keine Waisen-Dateien ───────────────────────────────────────────────

describe("upload route — Existenz-Check vor Platten-Schreiben", () => {
  it("Eintrag serverseitig nicht vorhanden → 409 entry_missing, keine Bytes auf der Platte", async () => {
    seedDb({ entryRow: null })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID }))

    expect(res.status).toBe(409)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("entry_missing")
    expect(mockMkdir).not.toHaveBeenCalled()
    expect(mockSaveFileToDisk).not.toHaveBeenCalled()
    expect(insertCalls()).toHaveLength(0)
  })

  it("Eintrag gelöscht (Tombstone) → 410 entry_deleted, keine Bytes auf der Platte", async () => {
    seedDb({ entryRow: { deleted_at: "2026-07-27T10:00:00.000Z" } })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID }))

    expect(res.status).toBe(410)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("entry_deleted")
    expect(mockMkdir).not.toHaveBeenCalled()
    expect(mockSaveFileToDisk).not.toHaveBeenCalled()
  })

  it("FK-Fehler beim INSERT (Eintrag im Fenster verschwunden) → Dateien werden entfernt, 503 retryable", async () => {
    const fkError = Object.assign(new Error("violates foreign key constraint"), { code: "23503" })
    seedDb({ insertError: fkError })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID }))

    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("media_insert_failed")
    expect(mockRm).toHaveBeenCalledOnce()
  })

  it("transienter DB-Fehler beim INSERT → Dateien werden entfernt, 503 retryable (kein Waisen-Leak mehr)", async () => {
    // Vorher: 201 ohne id + Datei blieb liegen — jeder fehlgeschlagene Versuch
    // stapelte eine unreferenzierte Volltauflösungs-Kopie auf der Pi-Platte.
    seedDb({ preCheckError: new Error("connection refused"), insertError: Object.assign(new Error("still down")) })

    const res = await POST(makeUploadReq({ entryId: ENTRY_ID, clientMediaId: CLIENT_MEDIA_ID }))

    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("media_insert_failed")
    expect(mockSaveFileToDisk).toHaveBeenCalledOnce()
    expect(mockRm).toHaveBeenCalledOnce()
  })
})
