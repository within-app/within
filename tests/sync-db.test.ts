/**
 * Sync DB layer tests — getChangesSince + upsertEntries.
 * LWW clock-drift tests — server-time authority + skew clamp.
 * Synthetic data only (Constraint D).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}))

vi.mock("@/lib/media-security", () => ({
  safeMediaPath: vi.fn((cwd: string, relPath: string) => `${cwd}/public${relPath}`),
}))

import { db } from "@/lib/db"
import { readFile } from "fs/promises"
import { getChangesSince, upsertEntries } from "../src/lib/db/sync"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID_A = "20000000-0000-4000-8000-000000000001"
const ENTRY_ID_B = "20000000-0000-4000-8000-000000000002"
const REV_ID_A   = "30000000-0000-4000-8000-000000000001"
const SINCE = "2026-01-01T00:00:00.000Z"

// Synthetic server "now" used in upsert tests
const SERVER_NOW = new Date("2026-06-17T10:00:00.000Z")

function makeDBRow(id: string, revisionId = REV_ID_A, deleted_at: Date | null = null, thumbnailPath: string | null = null) {
  return {
    id,
    journal_id: JOURNAL_ID,
    text: "Synthetic test entry",
    created_at: new Date("2026-06-01T10:00:00.000Z"),
    updated_at: new Date("2026-06-15T10:00:00.000Z"),
    revision_id: revisionId,
    starred: false,
    location_name: null,
    location_lat: null,
    location_lng: null,
    weather_description: null,
    weather_temp_celsius: null,
    weather_icon: null,
    tags: [],
    deleted_at,
    thumbnail_path: thumbnailPath,
  }
}

function makeSyncEntry(id: string = ENTRY_ID_A, updatedAt = "2026-06-15T10:00:00.000Z") {
  return {
    id,
    journalId: JOURNAL_ID,
    text: "Synthetic entry text",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt,
    revisionId: REV_ID_A,
    starred: false,
    tags: [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

/** Build a mock client that returns SERVER_NOW for SELECT NOW() and empty for everything else. */
function makeClientMock(overrides: (sql: string, params?: unknown[]) => { rows: unknown[] } | null = () => null) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const override = overrides(sql, params)
      if (override !== null) return override
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
}

describe("getChangesSince", () => {
  beforeEach(() => vi.mocked(db.query).mockReset())

  it("queries entries updated after `since` with correct WHERE clause", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
    await getChangesSince(SINCE, null, null, 50)
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("e.updated_at > $1::timestamptz")
    expect(params[0]).toBe(SINCE)
  })

  it("applies journalId filter when provided", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
    await getChangesSince(SINCE, JOURNAL_ID, null, 50)
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("e.journal_id = $4::uuid")
    expect(params[3]).toBe(JOURNAL_ID)
  })

  it("returns entries mapped to SyncEntry shape", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [makeDBRow(ENTRY_ID_A)] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0].id).toBe(ENTRY_ID_A)
    expect(page.entries[0].revisionId).toBe(REV_ID_A)
  })

  it("sets nextCursor when there are more rows than limit", async () => {
    const limit = 2
    const rows = [makeDBRow(ENTRY_ID_A), makeDBRow(ENTRY_ID_B), makeDBRow("20000000-0000-4000-8000-000000000003")]
    vi.mocked(db.query).mockResolvedValueOnce({ rows } as never)
    const page = await getChangesSince(SINCE, null, null, limit)
    expect(page.entries).toHaveLength(limit)
    expect(page.nextCursor).not.toBeNull()
  })

  it("sets nextCursor to null when results fit within limit", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [makeDBRow(ENTRY_ID_A)] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.nextCursor).toBeNull()
  })

  it("includes serverTime in response", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(typeof page.serverTime).toBe("string")
  })

  it("includes tombstoned entries with deletedAt set", async () => {
    const tombstone = makeDBRow(ENTRY_ID_A, REV_ID_A, new Date("2026-07-01T10:00:00.000Z"))
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [tombstone] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0].deletedAt).toBe("2026-07-01T10:00:00.000Z")
  })

  it("maps deletedAt to null when entry is not deleted", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [makeDBRow(ENTRY_ID_A)] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries[0].deletedAt).toBeNull()
  })
})

describe("upsertEntries — new entry", () => {
  let mockClient: ReturnType<typeof makeClientMock>

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = makeClientMock((sql) => {
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      return null
    })
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("INSERTs a new entry and returns it as accepted", async () => {
    const result = await upsertEntries([makeSyncEntry()])
    expect(result.accepted).toContain(ENTRY_ID_A)
    expect(result.conflicts).toHaveLength(0)
  })

  it("issues BEGIN and COMMIT wrapping all writes", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      return { rows: [] }
    })
    await upsertEntries([makeSyncEntry()])
    expect(sqls[0]).toBe("BEGIN")
    expect(sqls[sqls.length - 1]).toBe("COMMIT")
  })

  it("stores server time (not client time) as updated_at for new entries", async () => {
    const calls: Array<[string, unknown[]]> = []
    mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params ?? []])
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      return { rows: [] }
    })
    // Client claims updatedAt 30 minutes ahead of SERVER_NOW (simulating fast clock)
    const clientFutureTime = "2026-06-17T10:30:00.000Z"
    await upsertEntries([makeSyncEntry(ENTRY_ID_A, clientFutureTime)])
    const insertCall = calls.find(([sql]) => sql.includes("INSERT INTO entries"))
    expect(insertCall).toBeTruthy()
    // The updated_at param must be SERVER_NOW, not the client's future time
    const params = insertCall![1] as unknown[]
    const storedUpdatedAt = params.find(
      (p) => p instanceof Date && Math.abs(p.getTime() - SERVER_NOW.getTime()) < 1000
    )
    expect(storedUpdatedAt).toBeTruthy()
    // Must NOT store the client's future timestamp
    const badParam = params.find(
      (p) => p instanceof Date && new Date(clientFutureTime).getTime() === p.getTime()
    )
    expect(badParam).toBeUndefined()
  })
})

describe("upsertEntries — conflict: client wins", () => {
  let mockClient: ReturnType<typeof makeClientMock>

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = makeClientMock(() => null)
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("updates entry and saves conflict copy when client updatedAt is newer", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return { rows: [{ updated_at: new Date("2026-06-10T10:00:00.000Z"), revision_id: "rev-server", text: "Server version", created_at: new Date("2026-06-01T00:00:00.000Z"), starred: false, journal_id: JOURNAL_ID, location_name: null, location_lat: null, location_lng: null, weather_description: null, weather_temp_celsius: null, weather_icon: null, tags: [], deleted_at: null }] }
      }
      return { rows: [] }
    })
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, "2026-06-15T10:00:00.000Z")])
    expect(result.accepted).toContain(ENTRY_ID_A)
    const conflictInsert = sqls.find((s) => s.includes("sync_conflict_copies"))
    expect(conflictInsert).toBeTruthy()
    const updateEntry = sqls.find((s) => s.startsWith("UPDATE entries"))
    expect(updateEntry).toBeTruthy()
  })

  it("stores server time (not client time) as updated_at when client wins LWW", async () => {
    const calls: Array<[string, unknown[]]> = []
    mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params ?? []])
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return { rows: [{ updated_at: new Date("2026-06-10T10:00:00.000Z"), revision_id: "rev-server", text: "Server version", created_at: new Date("2026-06-01T00:00:00.000Z"), starred: false, journal_id: JOURNAL_ID, location_name: null, location_lat: null, location_lng: null, weather_description: null, weather_temp_celsius: null, weather_icon: null, tags: [] }] }
      }
      return { rows: [] }
    })
    // Client is 30 minutes fast, claims to have edited at serverNow+30min
    const clientFutureTime = "2026-06-17T10:30:00.000Z"
    await upsertEntries([makeSyncEntry(ENTRY_ID_A, clientFutureTime)])
    const updateCall = calls.find(([sql]) => sql.startsWith("UPDATE entries"))
    expect(updateCall).toBeTruthy()
    const params = updateCall![1] as unknown[]
    // updated_at param (index 4 in UPDATE, $5) must be SERVER_NOW
    const storedUpdatedAt = params.find(
      (p) => p instanceof Date && Math.abs(p.getTime() - SERVER_NOW.getTime()) < 1000
    )
    expect(storedUpdatedAt).toBeTruthy()
    const badParam = params.find(
      (p) => p instanceof Date && new Date(clientFutureTime).getTime() === p.getTime()
    )
    expect(badParam).toBeUndefined()
  })
})

describe("upsertEntries — tombstone wins (no resurrection)", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = { query: vi.fn(), release: vi.fn() }
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("accepts the edit without INSERT or UPDATE when the server has a tombstone for that id", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return { rows: [makeDBRow(ENTRY_ID_A, REV_ID_A, new Date("2026-07-01T00:00:00.000Z"))] }
      }
      return { rows: [] }
    })
    const result = await upsertEntries([makeSyncEntry()])
    // Seit dem Offline-Delete-Fix meldet der Server den Edit als accepted, damit
    // der Client ihn dequeued (sonst Endlos-Retry) — geschrieben wird weiterhin nichts.
    expect(result.accepted).toContain(ENTRY_ID_A)
    const insert = sqls.find((s) => s.includes("INSERT INTO entries"))
    const update = sqls.find((s) => s.startsWith("UPDATE entries"))
    expect(insert).toBeUndefined()
    expect(update).toBeUndefined()
  })
})

describe("upsertEntries — conflict: server wins", () => {
  let mockClient: ReturnType<typeof makeClientMock>

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = makeClientMock(() => null)
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("keeps server version and returns entry in conflicts when server updatedAt is newer", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return { rows: [{ updated_at: new Date("2026-06-20T10:00:00.000Z"), revision_id: "rev-server", text: "Server is newer", created_at: new Date("2026-06-01T00:00:00.000Z"), starred: false, journal_id: JOURNAL_ID, location_name: null, location_lat: null, location_lng: null, weather_description: null, weather_temp_celsius: null, weather_icon: null, tags: [], deleted_at: null }] }
      }
      return { rows: [] }
    })
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, "2026-06-15T10:00:00.000Z")])
    expect(result.accepted).not.toContain(ENTRY_ID_A)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].entryId).toBe(ENTRY_ID_A)
    const conflictInsert = sqls.find((s) => s.includes("sync_conflict_copies"))
    expect(conflictInsert).toBeTruthy()
    const updateEntry = sqls.find((s) => s.startsWith("UPDATE entries"))
    expect(updateEntry).toBeUndefined()
  })
})

// Thumbnail data URL inclusion in getChangesSince
describe("getChangesSince — thumbnailDataUrl", () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    vi.mocked(readFile).mockReset()
  })

  it("sets thumbnailDataUrl to null when entry has no photo (thumbnail_path is null)", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [makeDBRow(ENTRY_ID_A, REV_ID_A, null, null)] } as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries[0].thumbnailDataUrl).toBeNull()
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })

  it("reads the thumbnail file and returns a base64 data URL for WebP", async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // synthetic PNG-like bytes
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [makeDBRow(ENTRY_ID_A, REV_ID_A, null, "/media/abc/abc-thumb.webp")],
    } as never)
    vi.mocked(readFile).mockResolvedValueOnce(fakePng as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    const entry = page.entries[0]
    expect(entry.thumbnailDataUrl).toMatch(/^data:image\/webp;base64,/)
    expect(entry.thumbnailDataUrl).toContain(fakePng.toString("base64"))
  })

  it("sets thumbnailDataUrl to null when the thumbnail file is missing (non-fatal)", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [makeDBRow(ENTRY_ID_A, REV_ID_A, null, "/media/missing/missing-thumb.webp")],
    } as never)
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries[0].thumbnailDataUrl).toBeNull()
  })

  it("uses image/jpeg MIME for .jpg thumbnails", async () => {
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff])
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [makeDBRow(ENTRY_ID_A, REV_ID_A, null, "/media/abc/abc-original.jpg")],
    } as never)
    vi.mocked(readFile).mockResolvedValueOnce(fakeJpg as never)
    const page = await getChangesSince(SINCE, null, null, 50)
    expect(page.entries[0].thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it("upsert conflict serverVersion includes thumbnailDataUrl: null", async () => {
    const mockClient = { query: vi.fn(), release: vi.fn() }
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return { rows: [{ updated_at: new Date("2026-06-20T10:00:00.000Z"), revision_id: "rev-server", text: "Server is newer", created_at: new Date("2026-06-01T00:00:00.000Z"), starred: false, journal_id: JOURNAL_ID, location_name: null, location_lat: null, location_lng: null, weather_description: null, weather_temp_celsius: null, weather_icon: null, tags: [] }] }
      }
      return { rows: [] }
    })
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, "2026-06-15T10:00:00.000Z")])
    expect(result.conflicts[0].serverVersion.thumbnailDataUrl).toBeNull()
  })
})

describe("upsertEntries — LWW skew clamp", () => {
  let mockClient: ReturnType<typeof makeClientMock>

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = makeClientMock(() => null)
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("fast-clock client (> MAX_SKEW ahead) loses to server version updated within skew window", async () => {
    // SERVER_NOW = 2026-06-17T10:00:00Z
    // MAX_SKEW   = 5 minutes
    // Server entry was updated at serverNow + 6min = 10:06Z (just ahead of skew ceiling)
    // Client claims updatedAt = serverNow + 30min = 10:30Z (far-future fast clock)
    // Without clamp: client would win (10:30 > 10:06)
    // With skew clamp to serverNow + 5min = 10:05Z: 10:05 < 10:06 → server wins
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return {
          rows: [{
            updated_at: new Date("2026-06-17T10:06:00.000Z"), // 6 min after serverNow
            revision_id: "rev-server",
            text: "Server is authoritative",
            created_at: new Date("2026-06-01T00:00:00.000Z"),
            starred: false,
            journal_id: JOURNAL_ID,
            location_name: null, location_lat: null, location_lng: null,
            weather_description: null, weather_temp_celsius: null, weather_icon: null,
            tags: [],
          }],
        }
      }
      return { rows: [] }
    })
    // Client with fast clock claims +30min
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, "2026-06-17T10:30:00.000Z")])
    // Clamped effective time = serverNow + 5min = 10:05Z < server 10:06Z → server should win
    expect(result.accepted).not.toContain(ENTRY_ID_A)
    expect(result.conflicts).toHaveLength(1)
  })

  it("client with timestamp just within skew window still wins when server version is older", async () => {
    // Client claims serverNow + 3min (within MAX_SKEW of 5min)
    // Server entry was updated at serverNow - 10min
    // Client should still win
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return {
          rows: [{
            updated_at: new Date("2026-06-17T09:50:00.000Z"), // 10min before serverNow
            revision_id: "rev-server",
            text: "Server older version",
            created_at: new Date("2026-06-01T00:00:00.000Z"),
            starred: false,
            journal_id: JOURNAL_ID,
            location_name: null, location_lat: null, location_lng: null,
            weather_description: null, weather_temp_celsius: null, weather_icon: null,
            tags: [],
          }],
        }
      }
      return { rows: [] }
    })
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, "2026-06-17T10:03:00.000Z")])
    expect(result.accepted).toContain(ENTRY_ID_A)
    expect(result.conflicts).toHaveLength(0)
  })
})

// Retry after lost response must not create a bogus conflict copy
describe("upsertEntries — idempotent retry", () => {
  let mockClient: ReturnType<typeof makeClientMock>

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = makeClientMock(() => null)
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("accepts (not conflicts) when effectiveClientUpdatedAt === serverUpdatedAt [retry tie]", async () => {
    // Scenario: client sent an edit; server accepted and wrote updated_at = SERVER_NOW.
    // Response was lost. Client retries with the same updatedAt (= SERVER_NOW).
    // Strict > wrongly routes this to the conflict branch. >= treats it as client win.
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return {
          rows: [{
            updated_at: SERVER_NOW, // server already accepted the previous attempt
            revision_id: REV_ID_A,
            text: "Already accepted",
            created_at: new Date("2026-06-01T00:00:00.000Z"),
            starred: false,
            journal_id: JOURNAL_ID,
            location_name: null, location_lat: null, location_lng: null,
            weather_description: null, weather_temp_celsius: null, weather_icon: null,
            tags: [],
            deleted_at: null,
          }],
        }
      }
      return { rows: [] }
    })
    // Client retries with the same updatedAt that matches the server's stored value
    const result = await upsertEntries([makeSyncEntry(ENTRY_ID_A, SERVER_NOW.toISOString())])
    // Must be accepted (re-accepted), never a conflict
    expect(result.accepted).toContain(ENTRY_ID_A)
    expect(result.conflicts).toHaveLength(0)
  })

  it("does not insert a spurious sync_conflict_copies row on retry tie", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: SERVER_NOW }] }
      if (sql.includes("FROM entries e WHERE e.id")) {
        return {
          rows: [{
            updated_at: SERVER_NOW,
            revision_id: REV_ID_A,
            text: "Already accepted",
            created_at: new Date("2026-06-01T00:00:00.000Z"),
            starred: false,
            journal_id: JOURNAL_ID,
            location_name: null, location_lat: null, location_lng: null,
            weather_description: null, weather_temp_celsius: null, weather_icon: null,
            tags: [],
            deleted_at: null,
          }],
        }
      }
      return { rows: [] }
    })
    await upsertEntries([makeSyncEntry(ENTRY_ID_A, SERVER_NOW.toISOString())])
    const conflictInsert = sqls.find((s) => s.includes("sync_conflict_copies"))
    expect(conflictInsert).toBeUndefined()
  })
})
