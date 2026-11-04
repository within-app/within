/**
 * Zeitzone je Eintrag gegen echtes Postgres: Zählung, Kalender, Filter, Sync,
 * Import und das Nachtragen. Ein Mock könnte weder „AT TIME ZONE“ noch die
 * COALESCE-Typisierung prüfen. Needs a running Docker daemon. Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"
import { randomUUID } from "crypto"
import type { SyncEntry } from "@/lib/sync/types"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })
vi.mock("@/lib/request-guard", () => ({ guardApiRequest: async () => null }))

const syncEntry = (over: Partial<SyncEntry>) => ({
  locationName: null, locationLat: null, locationLng: null, weatherDescription: null,
  weatherTempCelsius: null, weatherIcon: null, deletedAt: null, thumbnailDataUrl: null,
  starred: false, tags: [], text: "a",
  createdAt: "2024-05-01T10:00:00.000Z", updatedAt: "2024-05-01T10:00:00.000Z",
  ...over,
}) as SyncEntry

const SCHEMA = readFileSync(join(__dirname, "../src/lib/db/schema.sql"), "utf-8")
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(url, "http://localhost:4000"), init)

describe("Zeitzone je Eintrag (echtes Postgres)", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string

  const insert = async (createdAt: string, tz: string | null) => {
    const id = randomUUID()
    await client.query(
      `INSERT INTO entries (id, journal_id, text, created_at, time_zone) VALUES ($1,$2,'synthetic',$3,$4)`,
      [id, journalId, createdAt, tz]
    )
    return id
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    vi.stubEnv("DATABASE_URL", container.getConnectionUri())
    vi.stubEnv("APP_TIMEZONE", "Europe/Berlin")
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(SCHEMA)
    process.chdir(mkdtempSync(join(tmpdir(), "within-tz-")))
  })
  afterAll(async () => {
    const { db } = await import("@/lib/db")
    await db.end?.()
    await client.end()
    await container.stop()
    vi.unstubAllEnvs()
  })
  beforeEach(async () => {
    await client.query("DELETE FROM entries")
    await client.query("DELETE FROM journals")
    const { rows: [j] } = await client.query(`INSERT INTO journals (name, color) VALUES ('T', '#000000') RETURNING id`)
    journalId = j.id
  })

  it("das Schema läuft ein zweites Mal durch und die Spalte ist da", async () => {
    await client.query(SCHEMA)
    const { rows } = await client.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='entries' AND column_name='time_zone'`
    )
    expect(rows).toEqual([{ is_nullable: "YES" }])
  })

  it("Statistik zählt Tage und Serie je Eintrag, ohne Zone in der App-Zone", async () => {
    const heute = new Date()
    const utcTag = (n: number, h: number) => {
      const d = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() - n, h, 0, 0))
      return d.toISOString()
    }
    // Beide am selben Berliner Tag, in ihren eigenen Zonen zwei aufeinanderfolgende Tage.
    // In Berlin-Zeit wäre es eine Lücke und die Serie nur 1.
    await insert(utcTag(3, 8), "Europe/Berlin")
    await insert(utcTag(3, 20), "Asia/Bangkok")
    // Gestern, ohne Zone: Rückfall auf Berlin
    await insert(utcTag(1, 8), null)
    const { GET } = await import("@/app/api/stats/route")
    const stats = await (await GET(req("/api/stats"))).json()
    expect(stats.totalEntries).toBe(3)
    expect(stats.totalDays).toBe(3)
    expect(stats.streak).toBe(3)
  })

  it("Kalender: ein Eintrag über die Monatsgrenze steht im Monat seines Tages", async () => {
    // Bangkok: 01.02. 03:00, Berlin: 31.01. 21:00
    await insert("2024-01-31T20:00:00.000Z", "Asia/Bangkok")
    const { GET } = await import("@/app/api/calendar/route")
    const feb = await (await GET(req("/api/calendar?from=2024-02&to=2024-02"))).json()
    const jan = await (await GET(req("/api/calendar?from=2024-01&to=2024-01"))).json()
    expect(Object.keys(feb)).toEqual(["2024-02-01"])
    expect(Object.keys(jan)).toEqual([])
  })

  it("Tagesfilter, An diesem Tag und Jahre folgen dem Tag des Eintrags", async () => {
    await insert("2023-12-31T20:00:00.000Z", "Asia/Bangkok") // Bangkok: 01.01.2024
    const { listEntries } = await import("@/lib/db/entries")
    const base = { journalId: null, date: null, onThisDay: null, year: null, before: null, searchQuery: null, tags: null, starred: null, mediaType: null, page: 1, perPage: 20, includeMedia: false }
    expect((await listEntries({ ...base, date: "2024-01-01" })).total).toBe(1)
    expect((await listEntries({ ...base, date: "2023-12-31" })).total).toBe(0)
    expect((await listEntries({ ...base, onThisDay: "01-01" })).total).toBe(1)
    expect((await listEntries({ ...base, year: 2024 })).total).toBe(1)
    const { rows } = await listEntries(base)
    expect(rows[0].time_zone).toBe("Asia/Bangkok")
    const { GET } = await import("@/app/api/entries/years/route")
    const years = await (await GET(req("/api/entries/years"))).json()
    expect(JSON.stringify(years)).toContain("2024")
    expect(JSON.stringify(years)).not.toContain("2023")
  })

  it("Monatssprung folgt dem Tag des Eintrags", async () => {
    const la = await insert("2026-02-01T04:00:00.000Z", "America/Los_Angeles") // LA: 31.01. 20:00
    const tokio = await insert("2026-01-31T20:00:00.000Z", "Asia/Tokyo") // Tokio: 01.02. 05:00
    const { listEntries } = await import("@/lib/db/entries")
    const base = { journalId: null, date: null, onThisDay: null, year: null, searchQuery: null, tags: null, starred: null, mediaType: null, page: 1, perPage: 20, includeMedia: false }
    const { rows, total } = await listEntries({ ...base, before: "2026-01" })
    expect(rows.map((r) => r.id)).toEqual([la])
    expect(total).toBe(1)
    expect(rows.map((r) => r.id)).not.toContain(tokio)
  })

  it("Zeitleiste liefert die Zone und sortiert die Tage absteigend", async () => {
    // Absolut früher, aber lokal der spätere Tag
    await insert("2024-03-10T20:00:00.000Z", "Asia/Bangkok") // Bangkok 11.03.
    await insert("2024-03-10T22:00:00.000Z", "Europe/Berlin") // Berlin 10.03. 23:00
    const { GET } = await import("@/app/api/entries/route")
    const data = await (await GET(req("/api/entries"))).json()
    expect(data.dateGroups.map((g: { date: string }) => g.date)).toEqual(["2024-03-11", "2024-03-10"])
    expect(data.dateGroups[0].entries[0].timeZone).toBe("Asia/Bangkok")
  })

  it("Sync: Zone reist mit, ein altes Gerät ohne das Feld löscht sie nicht", async () => {
    const { upsertEntries, getChangesSince } = await import("@/lib/db/sync")
    const id = randomUUID()
    await upsertEntries([syncEntry({ id, journalId, revisionId: randomUUID(), timeZone: "Asia/Tokyo" })])
    const read = async () => (await client.query(`SELECT time_zone FROM entries WHERE id=$1`, [id])).rows[0].time_zone
    expect(await read()).toBe("Asia/Tokyo")
    const later = new Date(Date.now() + 60_000).toISOString()
    await upsertEntries([syncEntry({ id, journalId, text: "b", updatedAt: later, revisionId: randomUUID() })])
    expect(await read()).toBe("Asia/Tokyo")
    const page = await getChangesSince("1970-01-01T00:00:00.000Z", null, null, 50)
    expect(page.entries[0].timeZone).toBe("Asia/Tokyo")
  })

  it("Sync: eine unbekannte Zone landet nicht in der Datenbank", async () => {
    const { upsertEntries } = await import("@/lib/db/sync")
    const id = randomUUID()
    await upsertEntries([syncEntry({ id, journalId, revisionId: randomUUID(), timeZone: "+02:00" })])
    const { rows } = await client.query(`SELECT time_zone FROM entries WHERE id=$1`, [id])
    expect(rows[0].time_zone).toBeNull()
  })

  it("Sync: ein Datenbankfehler bei der Zonenprüfung schreibt nichts und meldet den Fehler", async () => {
    const { resetAcceptedTimeZones } = await import("@/lib/db/time-zone")
    const { db } = await import("@/lib/db")
    const { upsertEntries } = await import("@/lib/db/sync")
    resetAcceptedTimeZones()
    const real = db.query.bind(db)
    const spy = vi.spyOn(db, "query").mockImplementation(((sql: string, params?: unknown[]) =>
      sql.includes("AT TIME ZONE $1") ? Promise.reject(new Error("timeout")) : real(sql, params)) as never)
    const id = randomUUID()
    await expect(upsertEntries([syncEntry({ id, journalId, revisionId: randomUUID(), timeZone: "Asia/Tokyo" })])).rejects.toThrow("timeout")
    spy.mockRestore()
    expect((await client.query(`SELECT 1 FROM entries WHERE id=$1`, [id])).rows).toHaveLength(0)
  })

  it("Neuer Eintrag: die Zonenprüfung braucht keine zweite Verbindung", async () => {
    const { resetAcceptedTimeZones } = await import("@/lib/db/time-zone")
    const { db } = await import("@/lib/db")
    resetAcceptedTimeZones()
    const spy = vi.spyOn(db, "query")
    const { POST } = await import("@/app/api/entries/route")
    const res = await POST(req("/api/entries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", journalId, timeZone: "Asia/Seoul" }),
    }))
    expect(res.status).toBe(201)
    expect(spy.mock.calls.filter(([sql]) => String(sql).includes("AT TIME ZONE $1"))).toHaveLength(0)
    spy.mockRestore()
  })

  it("Neuer Eintrag über die API speichert die Zone", async () => {
    const { POST } = await import("@/app/api/entries/route")
    const res = await POST(req("/api/entries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", journalId, timeZone: "Asia/Tokyo" }),
    }))
    expect(res.status).toBe(201)
    const { rows } = await client.query(`SELECT time_zone FROM entries`)
    expect(rows[0].time_zone).toBe("Asia/Tokyo")
  })

  describe("Import", () => {
    const hex = () => randomUUID().replace(/-/g, "").toUpperCase()
    const importZip = async (entries: object[]) => {
      const zip = zipSync({ "J.json": strToU8(JSON.stringify({ entries })) })
      const { POST } = await import("@/app/api/import/route")
      const res = await POST(req(`/api/import?journalId=${journalId}`, {
        method: "POST", headers: { "Content-Type": "application/zip" },
        body: Buffer.from(zip),
      }))
      return res.json()
    }

    it("Day One: gültige Zone übernommen, unlesbare bleibt leer, Import scheitert nicht", async () => {
      const a = hex(), b = hex()
      const result = await importZip([
        { uuid: a, text: "a", creationDate: "2024-02-01T10:00:00Z", timeZone: "America/Lima" },
        { uuid: b, text: "b", creationDate: "2024-02-02T10:00:00Z", timeZone: "GMT+2" },
      ])
      expect(result.imported).toBe(2)
      const { rows } = await client.query(`SELECT time_zone FROM entries ORDER BY created_at`)
      expect(rows.map((r) => r.time_zone)).toEqual(["America/Lima", null])
    })

    it("ein kurzer Datenbankfehler bei der Zonenprüfung kostet nichts dauerhaft", async () => {
      const { resetAcceptedTimeZones } = await import("@/lib/db/time-zone")
      const { db } = await import("@/lib/db")
      resetAcceptedTimeZones()
      const real = db.query.bind(db)
      const spy = vi.spyOn(db, "query").mockImplementation(((sql: string, params?: unknown[]) =>
        sql.includes("AT TIME ZONE $1") ? Promise.reject(new Error("timeout")) : real(sql, params)) as never)
      const entry = { uuid: hex(), text: "a", creationDate: "2024-02-03T10:00:00Z", timeZone: "America/Lima" }
      const first = await importZip([entry])
      spy.mockRestore()
      expect(first.imported).toBe(0)
      expect(first.errors).toHaveLength(1)
      const second = await importZip([entry])
      expect(second.imported).toBe(1)
      const { rows } = await client.query(`SELECT time_zone FROM entries`)
      expect(rows[0].time_zone).toBe("America/Lima")
    })

    it("Eigenes Export-Format behält die Zone", async () => {
      const id = randomUUID()
      const zip = zipSync({
        "export.json": strToU8(JSON.stringify({
          version: "1.0",
          journals: [{ id: journalId, name: "T" }],
          entries: [{ id, journalId, text: "x", createdAt: "2024-02-01T10:00:00.000Z", updatedAt: "2024-02-01T10:00:00.000Z", timeZone: "Asia/Dubai" }],
        })),
      })
      const { POST } = await import("@/app/api/import/route")
      await POST(req("/api/import", { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(zip) }))
      const { rows } = await client.query(`SELECT time_zone FROM entries WHERE id=$1`, [id])
      expect(rows[0].time_zone).toBe("Asia/Dubai")
    })
  })

  describe("Nachtragen POST /api/entries/time-zones", () => {
    const post = async (items: object[]) => {
      const { POST } = await import("@/app/api/entries/time-zones/route")
      return POST(req("/api/entries/time-zones", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
      }))
    }

    it("füllt nur leere Zonen, legt nichts an, ändert sonst nichts", async () => {
      const leer = await insert("2024-01-01T10:00:00.000Z", null)
      const gesetzt = await insert("2024-01-02T10:00:00.000Z", "Europe/Paris")
      const before = await client.query(`SELECT updated_at FROM entries WHERE id=$1`, [leer])
      const res = await post([
        { id: leer, timeZone: "Asia/Bangkok" },
        { id: gesetzt, timeZone: "Asia/Bangkok" },
        { id: randomUUID(), timeZone: "Asia/Bangkok" },
        { id: leer, timeZone: "+02:00" },
      ])
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ updated: 1, rejected: 1 })
      const { rows } = await client.query(`SELECT id, time_zone, updated_at FROM entries ORDER BY created_at`)
      expect(rows).toHaveLength(2)
      expect(rows[0].time_zone).toBe("Asia/Bangkok")
      expect(rows[1].time_zone).toBe("Europe/Paris")
      expect(rows[0].updated_at).toEqual(before.rows[0].updated_at)
    })

    it("stößt den Neuabgleich der Geräte nur an, wenn sich etwas geändert hat", async () => {
      const kennung = async () => (await client.query(`SELECT value FROM app_settings WHERE key='dataset_id'`)).rows[0]?.value
      await client.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('dataset_id', 'alt', NOW()) ON CONFLICT (key) DO UPDATE SET value = 'alt'`)
      const id = await insert("2024-01-01T10:00:00.000Z", null)
      await post([{ id, timeZone: "Asia/Bangkok" }])
      const danach = await kennung()
      expect(danach).not.toBe("alt")
      await post([{ id, timeZone: "Asia/Tokyo" }])
      expect(await kennung()).toBe(danach)
    })

    it("Nachtragen und Neuabgleich gelingen nur zusammen, eine Wiederholung holt beides nach", async () => {
      const kennung = async () => (await client.query(`SELECT value FROM app_settings WHERE key='dataset_id'`)).rows[0]?.value
      await client.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('dataset_id', 'alt', NOW()) ON CONFLICT (key) DO UPDATE SET value = 'alt'`)
      const id = await insert("2024-01-01T10:00:00.000Z", null)
      await client.query(`ALTER TABLE app_settings RENAME TO app_settings_weg`)
      const res = await post([{ id, timeZone: "Asia/Bangkok" }])
      await client.query(`ALTER TABLE app_settings_weg RENAME TO app_settings`)
      expect(res.status).toBe(503)
      const leer = await client.query(`SELECT time_zone FROM entries WHERE id=$1`, [id])
      expect(leer.rows[0].time_zone).toBeNull()
      const wieder = await post([{ id, timeZone: "Asia/Bangkok" }])
      expect(await wieder.json()).toEqual({ updated: 1, rejected: 0 })
      expect(await kennung()).not.toBe("alt")
    })

    it("meldet einen Datenbankfehler statt Einträge als abgelehnt zu zählen", async () => {
      const { resetAcceptedTimeZones } = await import("@/lib/db/time-zone")
      const { db } = await import("@/lib/db")
      resetAcceptedTimeZones()
      const spy = vi.spyOn(db, "query").mockRejectedValue(new Error("timeout") as never)
      const res = await post([{ id: randomUUID(), timeZone: "Asia/Bangkok" }])
      spy.mockRestore()
      expect(res.status).toBe(503)
    })

    it("lehnt zu große oder kaputte Anfragen ab", async () => {
      const zuviel = Array.from({ length: 5001 }, () => ({ id: randomUUID(), timeZone: "UTC" }))
      expect((await post(zuviel)).status).toBe(400)
      expect((await post([{ id: "keine-uuid", timeZone: "UTC" }])).status).toBe(400)
    })
  })
})
