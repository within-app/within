/**
 * DayOne-Import — frei wählbarer Journalname (?journalName=…)
 *
 * Der Auto-Pfad (kein journalId-Param) legt das Zieljournal bisher hart als
 * „DayOne Import" an. Neu: ?journalName bestimmt den Namen; leer/fehlend fällt
 * auf „DayOne Import" zurück, ein vorhandenes Journal gleichen Namens wird
 * wiederverwendet, Überlänge (>200) ist ein Validierungsfehler.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn(), connect: vi.fn() },
}))

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
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { db } from "@/lib/db"

// Minimal DayOne ZIP: one photo-less entry — enough to reach journal resolution.
function buildMinimalDayOneZip(): Uint8Array {
  const journal = {
    entries: [
      {
        uuid: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
        text: "Synthetic entry. Test data only.",
        creationDate: "2024-01-01T10:00:00Z",
        modifiedDate: "2024-01-01T10:00:00Z",
        starred: false,
        tags: [],
      },
    ],
  }
  return zipSync({ "Journal.json": strToU8(JSON.stringify(journal)) })
}

function makeImportRequest(query: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/import${query}`), {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: buildMinimalDayOneZip() as unknown as BodyInit,
  })
}

/** SQL an den Journal-Pool geschickt, mit Params — für Assertions unten. */
let poolCalls: Array<{ sql: string; params?: unknown[] }>

describe("POST /api/import — journalName param", () => {
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    poolCalls = []

    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      poolCalls.push({ sql: sql.trim(), params })
      if (sql.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
      if (sql.includes("INSERT INTO journals")) return { rows: [{ id: "journal-synth-id" }] }
      return { rows: [] }
    })

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s.includes("SELECT id FROM entries")) return { rows: [] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "tag-synth-id" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("falls back to 'DayOne Import' when journalName is absent", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(""))
    expect(res.status).toBe(200)

    const insert = poolCalls.find((c) => c.sql.includes("INSERT INTO journals"))
    expect(insert).toBeDefined()
    expect(insert!.params).toContain("DayOne Import")
  })

  it("falls back to 'DayOne Import' when journalName is whitespace only", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest("?journalName=%20%20"))
    expect(res.status).toBe(200)

    const insert = poolCalls.find((c) => c.sql.includes("INSERT INTO journals"))
    expect(insert).toBeDefined()
    expect(insert!.params).toContain("DayOne Import")
  })

  it("creates the journal under the given (trimmed) name", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest("?journalName=%20Reisen%202020%20"))
    expect(res.status).toBe(200)

    // Lookup und Insert laufen parameterisiert über den Wunschnamen.
    const select = poolCalls.find((c) => c.sql.includes("SELECT id FROM journals WHERE name"))
    expect(select).toBeDefined()
    expect(select!.params).toContain("Reisen 2020")

    const insert = poolCalls.find((c) => c.sql.includes("INSERT INTO journals"))
    expect(insert).toBeDefined()
    expect(insert!.params).toContain("Reisen 2020")
    expect(insert!.sql).not.toContain("Reisen 2020") // parameterised, not interpolated
  })

  it("reuses an existing journal with the same name instead of inserting", async () => {
    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      poolCalls.push({ sql: sql.trim(), params })
      if (sql.includes("SELECT id FROM journals WHERE name")) return { rows: [{ id: "journal-existing-id" }] }
      if (sql.includes("INSERT INTO journals")) return { rows: [{ id: "journal-wrong-id" }] }
      return { rows: [] }
    })

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest("?journalName=Reisen%202020"))
    expect(res.status).toBe(200)
    expect((await res.json()).imported).toBe(1)

    expect(poolCalls.some((c) => c.sql.includes("INSERT INTO journals"))).toBe(false)
  })

  it("rejects an over-long journalName (>200) with a validation error", async () => {
    const { POST } = await import("../src/app/api/import/route")
    const longName = "x".repeat(201)
    const res = await POST(makeImportRequest(`?journalName=${longName}`))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("validation_error")
  })
})
