/**
 * Tags — drei Befunde,
 * gegen echtes Postgres:
 *
 * 1. Doppelte Tag-Namen in EINEM Save (Combobox lässt sie durch, Zod dedupt
 *    nicht) trafen `INSERT … ON CONFLICT (name) DO UPDATE` — Postgres lehnt
 *    das ab („cannot affect row a second time“, 21000) → 500 bzw. im Sync
 *    ein zurückgerollter Push-Batch. Fix: SELECT DISTINCT UNNEST.
 * 2. Waisen-Tags: keine Unlink-Stelle (PUT replace-all, DELETE-Tombstone,
 *    Sync-Upsert, Journal-Cascade) löschte die tags-Zeile — Namen gelöschter
 *    Einträge blieben in DB und jedem pg_dump. Auch aus
 *    der DB löschen. Fix: replaceEntryTags() in der Transaktion, dann
 *    deleteOrphanTags() NACH dem COMMIT (Mini-Transaktionen, s. lib/db/tags.ts)
 *    + idempotenter Startup-Sweep in schema.sql (auch für Tombstone-Links).
 * 3. Ein Tag, das ein ANDERER lebender Eintrag noch hält, überlebt jedes
 *    Entkoppeln — die Kernzusage des NOT-EXISTS-Guards.
 *
 * Braucht Docker (testcontainers) wie stats-tombstone.test.ts. Synthetic only.
 */

import { describe, it, beforeAll, afterAll, expect, vi } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")

// Im Voll-Lauf starten sechs Postgres-Container gleichzeitig — ein Route-Call
// gegen den echten Container reißt dann das 5-s-Default (Muster read-routes-
// tombstone-filter.test.ts). Großzügig statt Flake.
vi.setConfig({ testTimeout: 30_000 })

const ISO = "2026-09-02T10:00:00.000Z"
// LWW: zweiter Upsert muss den serverseitigen NOW() des ersten schlagen —
// Host- und Container-Uhr dürfen dafür nicht verglichen werden (Docker-Drift).
// Ferne Zukunft wird auf serverNow + 5 min geklemmt und gewinnt deterministisch.
const FAR_FUTURE = "2099-01-01T00:00:00.000Z"

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("tags — doppelte Namen toleriert, Waisen an jeder Unlink-Stelle gelöscht, geteilte Tags überleben", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))
    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    journalId = journal.id
    // Pool in @/lib/db liest DATABASE_URL beim ersten Import.
    process.env.DATABASE_URL = container.getConnectionUri()
  }, 120_000)

  afterAll(async () => {
    await client?.end()
    await container?.stop()
    // Nicht in den Worker-Prozess leaken: Mock-Tests späterer Dateien stubben
    // DATABASE_URL selbst und dürfen keine echte Container-URL vorfinden.
    delete process.env.DATABASE_URL
  })

  const linkCount = async (entryId: string) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM entry_tags WHERE entry_id = $1`, [entryId]
    )
    return Number(rows[0].n)
  }
  const tagNames = async () => {
    const { rows } = await client.query<{ name: string }>(`SELECT name FROM tags ORDER BY name`)
    return rows.map((r) => r.name)
  }
  const postEntry = async (jid: string, text: string, tags: string[]) => {
    const { POST } = await import("../src/app/api/entries/route")
    const res = await POST(new NextRequest("http://localhost/api/entries", {
      method: "POST", ...json({ journalId: jid, text, tags }),
    }))
    expect(res.status).toBe(201)
    return (await res.json()).id as string
  }

  let entryId: string

  it("POST mit ['Dup','Dup','Solo'] → 201 und genau zwei Verknüpfungen", async () => {
    entryId = await postEntry(journalId, "synthetic", ["Dup", "Dup", "Solo"])
    expect(await linkCount(entryId)).toBe(2)
    expect(await tagNames()).toEqual(["Dup", "Solo"])
  })

  it("PUT replace-all mit ['Dup','Dup'] → 200; 'Solo' verliert Verknüpfung UND Zeile, 'Dup' bleibt", async () => {
    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const res = await PUT(
      new NextRequest(`http://localhost/api/entries/${entryId}`, {
        method: "PUT", ...json({ journalId, text: "synthetic v2", createdAt: ISO, tags: ["Dup", "Dup"] }),
      }),
      { params: Promise.resolve({ id: entryId }) }
    )
    expect(res.status).toBe(200)
    expect(await linkCount(entryId)).toBe(1)
    const names = await tagNames()
    expect(names).not.toContain("Solo")
    expect(names).toContain("Dup")
  })

  it("Sync-Upsert mit ['Sync','Sync'] → accepted; zweiter Upsert ohne Tags löscht 'Sync'", async () => {
    const { POST } = await import("../src/app/api/sync/upsert/route")
    const id = "20000000-0000-4000-8000-00000000abcd"
    const base = { id, journalId, text: "synthetic sync", createdAt: ISO, starred: false }
    const first = await POST(new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST", ...json({ entries: [{ ...base, updatedAt: ISO,
        revisionId: "30000000-0000-4000-8000-00000000abcd", tags: ["Sync", "Sync", "  "] }] }),
    }))
    expect(first.status).toBe(200)
    expect((await first.json()).accepted).toContain(id)
    expect(await linkCount(id)).toBe(1) // Duplikat gefaltet, Leerstring gefiltert
    const afterFirst = await tagNames()
    expect(afterFirst).toContain("Sync")
    expect(afterFirst).not.toContain("")

    const second = await POST(new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST", ...json({ entries: [{ ...base, updatedAt: FAR_FUTURE,
        revisionId: "30000000-0000-4000-8000-00000000abce", tags: [] }] }),
    }))
    expect(second.status).toBe(200)
    expect((await second.json()).accepted).toContain(id)
    expect(await linkCount(id)).toBe(0)
    expect(await tagNames()).not.toContain("Sync")
  })

  it("Journal löschen (Cascade) räumt die Tags seiner Einträge mit ab", async () => {
    const { rows: [j2] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Second', '#000000') RETURNING id`
    )
    await postEntry(j2.id, "synthetic j2", ["Only"])
    expect(await tagNames()).toContain("Only")

    const { DELETE } = await import("../src/app/api/journals/[id]/route")
    const res = await DELETE(new NextRequest(`http://localhost/api/journals/${j2.id}`), {
      params: Promise.resolve({ id: j2.id }),
    })
    expect(res.status).toBe(200)
    const names = await tagNames()
    expect(names).not.toContain("Only")
    expect(names).toContain("Dup") // lebend im anderen Journal — der Cascade-Pfad darf nur Waisen nehmen
    // orphanTagIds ist der einzige Kandidaten-Lieferant dieses Pfads — direkt prüfen.
    const { orphanTagIds } = await import("../src/lib/db/tags")
    const { db } = await import("../src/lib/db")
    const c = await db.connect()
    try { expect(await orphanTagIds(c)).toEqual([]) } finally { c.release() }
  })

  it("Migration löst Tombstone-Links, der Sweep räumt Alt-Waisen — die Migration selbst löscht keine Tags", async () => {
    // Waise ohne jede Verknüpfung + ein Tag, dessen einzige Verknüpfung an
    // einem Tombstone hängt (Crash in der nicht-transaktionalen DELETE-Phase).
    await client.query(`INSERT INTO tags (name) VALUES ('Waise'), ('Alt')`)
    await client.query(
      `WITH t AS (INSERT INTO entries (journal_id, text, created_at, deleted_at) VALUES ($1, '', NOW(), NOW()) RETURNING id)
       INSERT INTO entry_tags (entry_id, tag_id) SELECT t.id, tg.id FROM t, tags tg WHERE tg.name = 'Alt'`,
      [journalId]
    )
    expect(await tagNames()).toEqual(["Alt", "Dup", "Waise"])
    const { runMigrations } = await import("../src/lib/db/migrate")
    await runMigrations()
    // Schritt (1) hat den Tombstone-Link gelöst, aber keine tags-Zeile angefasst.
    expect(await tagNames()).toEqual(["Alt", "Dup", "Waise"])
    const { sweepOrphanTags } = await import("../src/lib/db/tags")
    expect(await sweepOrphanTags()).toBe(2)
    expect(await tagNames()).toEqual(["Dup"]) // lebend verknüpft → bleibt
  })

  it("DELETE-Tombstone: geteiltes 'Dup' überlebt (anderer Eintrag hält es), nur das Exklusive fällt", async () => {
    const keepId = await postEntry(journalId, "synthetic keep", ["Bleibt", "Dup"])
    // entryId hält jetzt 'Dup' + ein nur ihm gehörendes 'Exklusiv'
    const { PUT, DELETE } = await import("../src/app/api/entries/[id]/route")
    const put = await PUT(
      new NextRequest(`http://localhost/api/entries/${entryId}`, {
        method: "PUT", ...json({ journalId, text: "synthetic v3", createdAt: ISO, tags: ["Dup", "Exklusiv"] }),
      }),
      { params: Promise.resolve({ id: entryId }) }
    )
    expect(put.status).toBe(200)

    const res = await DELETE(new NextRequest(`http://localhost/api/entries/${entryId}`), {
      params: Promise.resolve({ id: entryId }),
    })
    expect(res.status).toBe(200)
    expect(await tagNames()).toEqual(["Bleibt", "Dup"])
    expect(await linkCount(keepId)).toBe(2)

    const { GET } = await import("../src/app/api/tags/route")
    const listed = await GET()
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { name: string }[]).map((t) => t.name)).toEqual(["Bleibt", "Dup"])
  })
})
