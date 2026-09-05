/**
 * Round-Trip-Import für within's eigenes v1.0 Export-Format
 *
 * Red assertions (fail before implementation):
 *   1. Round-trip: v1.0 ZIP → alle Felder korrekt in DB-Spalten gemappt
 *   2. Idempotenz: zweiter Import derselben ZIP → alles skipped, keine Duplikate
 *   3. DayOne-Regression: bestehender DayOne-Import bleibt grün
 *   4. Fehlerfall: v1.0-Eintrag mit ungültiger UUID → per-entry error, Rest importiert
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

// Mock the Node `fs` module so the streaming ZIP writer never touches the real disk.
vi.mock("fs", () => {
  function makeFakeWriteStream() {
    const cbs: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      once(ev: string, cb: (...a: unknown[]) => void) { (cbs[ev] ??= []).push(cb); return this },
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(function (this: ReturnType<typeof makeFakeWriteStream>) {
        ;(cbs["finish"] ?? []).forEach(fn => fn())
      }),
      destroy: vi.fn(function (this: ReturnType<typeof makeFakeWriteStream>) {
        ;(cbs["error"] ?? []).forEach(fn => fn(new Error("destroyed")))
      }),
    }
  }
  return {
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => makeFakeWriteStream()),
  }
})

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ── Synthetic test data ────────────────────────────────────────────────────

const JOURNAL_ID = "11111111-1111-4111-8111-111111111111"
const ENTRY_ID   = "22222222-2222-4222-8222-222222222222"
const PHOTO_FILE = "22222222-2222-4222-8222-222222222222-original.jpg"

const SYNTH_ENTRY = {
  id:        ENTRY_ID,
  journalId: JOURNAL_ID,
  text:      "Synthetic round-trip entry",
  createdAt: "2024-06-01T08:00:00.000Z",
  updatedAt: "2024-06-01T09:00:00.000Z",
  starred:   true,
  location:  { name: "Testort", latitude: 52.5, longitude: 13.4 },
  weather:   { description: "Sonnig", temperatureCelsius: 22, icon: "sunny" },
  tags:      ["synth-a", "synth-b"],
  photos:    [{ filename: PHOTO_FILE, orderIndex: 0 }],
}

const SYNTH_JOURNAL = { id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }

function buildV1Zip(
  entries: object[] = [SYNTH_ENTRY],
  journals: object[] = [SYNTH_JOURNAL]
): Uint8Array {
  const exportData = {
    version: "1.0",
    exportedAt: "2024-06-01T10:00:00.000Z",
    journals,
    entries,
  }
  return zipSync({
    "export.json": strToU8(JSON.stringify(exportData)),
    [`photos/${ENTRY_ID}/${PHOTO_FILE}`]: new Uint8Array(64).fill(0xab),
  })
}

function buildDayOneZip(): Uint8Array {
  const journal = {
    entries: [
      {
        uuid: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        text: "Synthetic DayOne entry",
        creationDate: "2024-05-01T10:00:00Z",
        starred: false,
        tags: ["dayone-tag"],
      },
    ],
  }
  return zipSync({ "Journal.json": strToU8(JSON.stringify(journal)) })
}

function makeImportRequest(body: Uint8Array): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/import"), {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: body as unknown as BodyInit,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/import — v1.0 Round-Trip", () => {
  let capturedQueries: Array<{ sql: string; params?: unknown[] }>

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    capturedQueries = []

    const { db } = await import("@/lib/db")

    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedQueries.push({ sql: sql.trim(), params })
        const s = sql.trim()
        if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
          return { rows: [] }
        if (s.includes("SELECT id FROM entries")) return { rows: [] }
        if (s.includes("INSERT INTO entries"))    return { rows: [] }
        if (s.includes("INSERT INTO media"))      return { rows: [] }
        if (s.includes("INSERT INTO tags"))
          return { rows: [{ id: "t1" }, { id: "t2" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }

    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql: sql.trim(), params })
      const s = sql.trim()
      // v1.0: journal upsert
      if (s.includes("INSERT INTO journals") && s.includes("ON CONFLICT"))
        return { rows: [] }
      // DayOne: fallback journal resolution
      if (s.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
      if (s.includes("INSERT INTO journals"))
        return { rows: [{ id: JOURNAL_ID }] }
      // v1.0 fallback: SELECT id FROM journals WHERE id
      if (s.includes("SELECT id FROM journals WHERE id")) return { rows: [{ id: JOURNAL_ID }] }
      return { rows: [] }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    // resetAllMocks clears implementations + "once" queues so nothing bleeds across tests
    vi.resetAllMocks()
  })

  // ── Test 1: Round-trip field mapping ─────────────────────────────────────

  it("imports v1.0 ZIP with correct field mapping (round-trip)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip()))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      imported: number
      skipped: number
      errors: string[]
    }
    expect(body.imported).toBe(1)
    expect(body.skipped).toBe(0)
    expect(body.errors).toHaveLength(0)

    // Journal upsert must have been called (v1.0 path restores journals by id)
    const journalUpsert = capturedQueries.find(
      q => q.sql.includes("INSERT INTO journals") && q.sql.includes("ON CONFLICT")
    )
    expect(journalUpsert).toBeDefined()

    // Verify INSERT INTO entries parameter mapping
    const insertEntry = capturedQueries.find(q => q.sql.includes("INSERT INTO entries"))
    expect(insertEntry).toBeDefined()
    const p = insertEntry!.params!

    expect(p[0]).toBe(ENTRY_ID)                      // id: used directly (not hashed)
    expect(p[1]).toBe(JOURNAL_ID)                     // journal_id: from entry.journalId
    expect(p[2]).toBe("Synthetic round-trip entry")   // text through cleanText
    expect(p[3]).toBe("2024-06-01T08:00:00.000Z")    // created_at from createdAt
    expect(p[4]).toBe("2024-06-01T09:00:00.000Z")    // updated_at from updatedAt
    expect(p[5]).toBe(true)                           // starred
    expect(p[6]).toBe("Testort")                      // location_name from location.name
    expect(p[7]).toBe(52.5)                           // location_lat from location.latitude
    expect(p[8]).toBe(13.4)                           // location_lng from location.longitude
    expect(p[9]).toBe("Sonnig")                       // weather_description from weather.description
    expect(p[10]).toBe(22)                            // weather_temp_celsius (rounded int)
    // weather_icon: must be "sunny" DIRECTLY from icon — NOT through mapWeatherCode
    // (mapWeatherCode does not recognise "sunny" and would return "cloudy" for unknowns)
    expect(p[11]).toBe("sunny")

    // Photo resolved from photos/${entryId}/${filename}, not photos/${md5}.${type}
    const mediaInsert = capturedQueries.find(q => q.sql.includes("INSERT INTO media"))
    expect(mediaInsert).toBeDefined()
  })

  // ── Test 2: Idempotency ───────────────────────────────────────────────────

  it("skips all entries on second import (idempotency, no duplicates)", async () => {
    const { db } = await import("@/lib/db")

    // Override: entry already exists in DB (simulates second import).
    // Existence check now uses pool-level db.query(), not a checked-out client,
    // so we must mock db.query in addition to db.connect.
    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql: sql.trim(), params })
      const s = sql.trim()
      if (s.includes("INSERT INTO journals") && s.includes("ON CONFLICT")) return { rows: [] }
      if (s.includes("SELECT id FROM journals WHERE id")) return { rows: [{ id: JOURNAL_ID }] }
      if (s.includes("SELECT id FROM entries")) return { rows: [{ id: ENTRY_ID }] } // already present
      return { rows: [] }
    })
    vi.mocked(db.connect).mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
          return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip()))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; skipped: number }
    expect(body.imported).toBe(0)
    expect(body.skipped).toBe(1)

    // No INSERT INTO entries should have been issued
    const entryInserts = capturedQueries.filter(q => q.sql.includes("INSERT INTO entries"))
    expect(entryInserts).toHaveLength(0)
  })

  // ── Test 3: DayOne regression ─────────────────────────────────────────────

  it("DayOne-Regression: existing DayOne ZIP imports correctly (no v1.0 breakage)", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildDayOneZip()))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; errors: string[] }
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)

    // DayOne path: uuid is hex → toUUID() → standard UUID format
    const insertEntry = capturedQueries.find(q => q.sql.includes("INSERT INTO entries"))
    expect(insertEntry).toBeDefined()
    const entryId = insertEntry!.params![0] as string
    expect(entryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // DayOne path: journal resolution via SELECT … WHERE name = 'DayOne Import'
    const dayOneJournalQuery = capturedQueries.find(
      q => q.sql.includes("SELECT id FROM journals WHERE name")
    )
    expect(dayOneJournalQuery).toBeDefined()
  })

  // ── Test 5: Video roundtrip ───────────────────────────────────────────────

  it("imports v1.0 ZIP video entry — media INSERT uses type='video'", async () => {
    const VIDEO_FILE = "synth-video.mp4"
    const videoEntry = {
      ...SYNTH_ENTRY,
      photos: [],
      videos: [{ filename: VIDEO_FILE, orderIndex: 0, durationSeconds: 42 }],
    }

    const zip = zipSync({
      "export.json": strToU8(JSON.stringify({
        version: "1.0",
        exportedAt: "2024-06-01T10:00:00.000Z",
        journals: [SYNTH_JOURNAL],
        entries: [videoEntry],
      })),
      [`videos/${ENTRY_ID}/${VIDEO_FILE}`]: new Uint8Array(32).fill(0xcc),
    })

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(zip))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; errors: string[] }
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)

    // Must have issued exactly one media INSERT with type='video'
    const mediaInserts = capturedQueries.filter(q => q.sql.includes("INSERT INTO media"))
    expect(mediaInserts).toHaveLength(1)
    expect(mediaInserts[0].sql).toContain("'video'")
  })

  // ── Test 6: Video with poster+loop restores thumbnail_path + preview_path ───

  it("imports v1.0 ZIP video with thumbnailFilename+previewFilename — sets thumbnail_path/preview_path in DB", async () => {
    const VIDEO_FILE   = "synth-video.mp4"
    const THUMB_FILE   = "synth-thumb.webp"
    const PREVIEW_FILE = "synth-preview.webp"
    const videoEntry = {
      ...SYNTH_ENTRY,
      photos: [],
      videos: [{
        filename:        VIDEO_FILE,
        orderIndex:      0,
        durationSeconds: 15,
        thumbnailFilename: THUMB_FILE,
        previewFilename:   PREVIEW_FILE,
      }],
    }

    const zip = zipSync({
      "export.json": strToU8(JSON.stringify({
        version: "1.0",
        exportedAt: "2024-06-01T10:00:00.000Z",
        journals: [SYNTH_JOURNAL],
        entries: [videoEntry],
      })),
      [`videos/${ENTRY_ID}/${VIDEO_FILE}`]:             new Uint8Array(32).fill(0xcc),
      [`video-thumbnails/${ENTRY_ID}/${THUMB_FILE}`]:   new Uint8Array(16).fill(0xdd),
      [`video-previews/${ENTRY_ID}/${PREVIEW_FILE}`]:   new Uint8Array(16).fill(0xee),
    })

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(zip))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; errors: string[] }
    expect(body.imported).toBe(1)
    expect(body.errors).toHaveLength(0)

    const mediaInserts = capturedQueries.filter(q => q.sql.includes("INSERT INTO media"))
    expect(mediaInserts).toHaveLength(1)
    expect(mediaInserts[0].sql).toContain("'video'")

    // KEY ASSERTION: thumbnail_path and preview_path must NOT be NULL in the INSERT.
    // Import normalises filenames to <uuid>-thumb.webp / <uuid>-preview.webp, so we
    // match on the suffix rather than the original ZIP filename.
    const insertSql = mediaInserts[0]
    const params = insertSql.params as unknown[]

    // params[2] = thumbnail_paths array, params[3] = preview_paths array (after update)
    const thumbPaths  = params[2] as string[]
    const previewPaths = params[3] as string[]
    expect(thumbPaths).toHaveLength(1)
    expect(previewPaths).toHaveLength(1)
    expect(thumbPaths[0]).not.toBeNull()
    expect(thumbPaths[0]).toMatch(/-thumb\.webp$/)
    expect(previewPaths[0]).not.toBeNull()
    expect(previewPaths[0]).toMatch(/-preview\.webp$/)
  })

  // ── Test 4: Error case — invalid UUID ────────────────────────────────────

  it("returns per-entry error for invalid UUID, rest of entries still import", async () => {
    const goodId = "33333333-3333-4333-8333-333333333333"
    const entries = [
      { ...SYNTH_ENTRY, id: "not-a-valid-uuid", journalId: JOURNAL_ID, photos: [] },
      { ...SYNTH_ENTRY, id: goodId,             journalId: JOURNAL_ID, photos: [] },
    ]

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(buildV1Zip(entries)))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      imported: number
      errors: string[]
    }
    // Valid entry must still be imported despite the bad one
    expect(body.imported).toBe(1)
    // Per-entry error reported for the invalid UUID entry
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]).toContain("not-a-valid-uuid")
  })
})
