/**
 * CR-03: photos added after first autosave are lost
 *
 * Root cause: PhotoUploader receives entryId={initialEntry?.id} which is
 * undefined for new entries. After autosave the entry exists in DB but
 * PhotoUploader still uploads without ?entryId= → no media row inserted.
 * Next save is a PUT → PUT ignored photos → photo gone, file orphaned.
 *
 * Red tests verify:
 *  1. UpdateEntrySchema now accepts a `photos` field (was missing → PUT never
 *     validated/passed photos to the handler).
 *  2. PUT /api/entries/[id] inserts a media row for each photo in the payload
 *     that lacks an `id` (unlinked upload) and is not already in the DB.
 *  3. PUT does NOT double-insert a photo whose file_path already has a row.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { UpdateEntrySchema } from "../src/lib/schemas/entry.schema"

// ── 1. Schema ─────────────────────────────────────────────────────────────────

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"

describe("UpdateEntrySchema — photos field", () => {
  it("accepts a valid update payload that includes photos", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
      photos: [
        { filePath: "/media/abc/photo.jpg", thumbnailPath: "/media/abc/thumb.webp", id: VALID_UUID },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("accepts a valid update payload with an unlinked photo (no id field)", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
      photos: [{ filePath: "/media/abc/photo.jpg" }],
    })
    expect(result.success).toBe(true)
  })

  it("accepts a valid update payload without photos (field is optional)", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
    })
    expect(result.success).toBe(true)
  })

  it("accepts photos of all media types", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
      photos: [
        { filePath: "/media/a/photo.jpg", type: "photo" },
        { filePath: "/media/b/video.mp4", type: "video" },
        { filePath: "/media/c/audio.mp3", type: "audio" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("rejects an invalid media type", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
      photos: [{ filePath: "/media/a/x.jpg", type: "gif" }],
    })
    expect(result.success).toBe(false)
  })
})

// ── 2 & 3. PUT handler — media linking ────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

const ENTRY_ID   = "00000000-0000-4000-8000-aaaaaaaaaaaa"
const JOURNAL_ID = "00000000-0000-4000-8000-000000000001"
const PHOTO_PATH = "/media/def456/def456-original.jpg"
const THUMB_PATH = "/media/def456/def456-thumb.webp"

describe("PUT /api/entries/[id] — links unlinked photos", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("inserts a media row for an unlinked photo (no id in payload, not yet in DB)", async () => {
    const { db } = await import("@/lib/db")
    const insertedMedia: string[][] = []

    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = sql.trim().toUpperCase()
        if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] }
        if (s.startsWith("UPDATE ENTRIES")) return { rows: [] }
        if (s.startsWith("DELETE FROM ENTRY_TAGS")) return { rows: [] }
        // Simulate no existing media for this entry
        if (s.includes("SELECT FILE_PATH FROM MEDIA")) return { rows: [] }
        // order_index subquery inside the INSERT
        if (s.includes("INSERT INTO MEDIA")) {
          insertedMedia.push(params as string[])
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const req = new NextRequest(
      new URL(`http://localhost:3000/api/entries/${ENTRY_ID}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journalId: JOURNAL_ID,
          createdAt: "2026-06-15T10:30:00.000Z",
          photos: [{ filePath: PHOTO_PATH, thumbnailPath: THUMB_PATH }],
        }),
      }
    )

    const res = await PUT(req, { params: Promise.resolve({ id: ENTRY_ID }) })
    expect(res.status).toBe(200)
    // At least one INSERT INTO media call must have been made for the unlinked photo
    expect(insertedMedia.length).toBeGreaterThan(0)
    const allParams = insertedMedia.flat()
    expect(allParams).toContain(PHOTO_PATH)
  })

  it("does NOT insert a media row when the photo file_path already exists in DB for this entry", async () => {
    const { db } = await import("@/lib/db")
    const insertedMedia: string[][] = []

    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = sql.trim().toUpperCase()
        if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] }
        if (s.startsWith("UPDATE ENTRIES")) return { rows: [] }
        if (s.startsWith("DELETE FROM ENTRY_TAGS")) return { rows: [] }
        // Simulate the photo already being in the DB
        if (s.includes("SELECT FILE_PATH FROM MEDIA")) {
          return { rows: [{ file_path: PHOTO_PATH }] }
        }
        if (s.includes("INSERT INTO MEDIA")) {
          insertedMedia.push(params as string[])
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const req = new NextRequest(
      new URL(`http://localhost:3000/api/entries/${ENTRY_ID}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journalId: JOURNAL_ID,
          createdAt: "2026-06-15T10:30:00.000Z",
          photos: [{ filePath: PHOTO_PATH, thumbnailPath: THUMB_PATH }],
        }),
      }
    )

    const res = await PUT(req, { params: Promise.resolve({ id: ENTRY_ID }) })
    expect(res.status).toBe(200)
    // No INSERT INTO media should have been called — photo already linked
    expect(insertedMedia.length).toBe(0)
  })

  it("skips photo linking when all payload photos already have an id (already in DB)", async () => {
    const { db } = await import("@/lib/db")
    const insertedMedia: string[][] = []

    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = sql.trim().toUpperCase()
        if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] }
        if (s.startsWith("UPDATE ENTRIES")) return { rows: [] }
        if (s.startsWith("DELETE FROM ENTRY_TAGS")) return { rows: [] }
        if (s.includes("SELECT FILE_PATH FROM MEDIA")) return { rows: [] }
        if (s.includes("INSERT INTO MEDIA")) {
          insertedMedia.push(params as string[])
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const req = new NextRequest(
      new URL(`http://localhost:3000/api/entries/${ENTRY_ID}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journalId: JOURNAL_ID,
          createdAt: "2026-06-15T10:30:00.000Z",
          // All photos have id → already linked, nothing to insert
          photos: [{ filePath: PHOTO_PATH, thumbnailPath: THUMB_PATH, id: VALID_UUID }],
        }),
      }
    )

    const res = await PUT(req, { params: Promise.resolve({ id: ENTRY_ID }) })
    expect(res.status).toBe(200)
    expect(insertedMedia.length).toBe(0)
  })
})
