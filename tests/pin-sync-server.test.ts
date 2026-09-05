/**
 * Pin-Sync Server-Seite („Wenn ich auf dem Desktop
 * einen Eintrag unpinne, muss das auch mit meinem Handy syncen.")
 *
 * - `entries.pinned_at timestamptz NULL` (schema.sql, idempotente Migration)
 * - `PUT /api/entries/[id]/pin { pinned: boolean }` setzt/löscht pinned_at,
 *   bumpt updated_at (damit die Änderung im Sync-Feed reist), ändert
 *   revision_id NICHT: Pin ist Metadatum — ein revision-Bump würde für
 *   parallele Text-Edits Konfliktkopien fabrizieren (Präzedenz: DELETE
 *   /api/media).
 * - getChangesSince liefert pinnedAt mit.
 * - Der Sync-Upsert vom Client überschreibt pinned_at NIE (weder SQL noch
 *   Zod lassen das Feld durch) — sonst würde jeder Text-Push den Pin-Status
 *   eines anderen Geräts wegschreiben.
 *
 * Echt-DB via @testcontainers/postgresql (braucht Docker, Muster
 * put-missing-row-and-tombstone.test.ts). Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"
import { UpsertRequestSchema } from "../src/lib/schemas/sync.schema"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")
const MISSING_ID = "99999999-0000-4000-8000-000000000000"

describe("Pin-Sync Server (pinned_at + PUT /api/entries/[id]/pin + Feed)", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string
  let pinRoute: typeof import("../src/app/api/entries/[id]/pin/route")
  let syncDb: typeof import("../src/lib/db/sync")

  const doPin = async (id: string, body: unknown) =>
    pinRoute.PUT(
      new NextRequest(`http://localhost/api/entries/${id}/pin`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) }
    )

  const entryRow = async (id: string) => {
    const { rows } = await client.query<{
      pinned_at: Date | null
      updated_at: Date
      revision_id: string
    }>(`SELECT pinned_at, updated_at, revision_id FROM entries WHERE id = $1`, [id])
    return rows[0]
  }

  const insertEntry = async (deleted = false) => {
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, deleted_at)
       VALUES ($1, 'synthetic', NOW(), ${deleted ? "NOW()" : "NULL"}) RETURNING id`,
      [journalId]
    )
    return row.id
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))
    // Idempotenz der Migration: zweiter Lauf darf nicht fehlschlagen.
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    journalId = journal.id

    process.env.DATABASE_URL = container.getConnectionUri()
    pinRoute = await import("../src/app/api/entries/[id]/pin/route")
    syncDb = await import("../src/lib/db/sync")
  }, 120_000)

  afterAll(async () => {
    await client?.end()
    await container?.stop()
  })

  it("Migration: entries.pinned_at existiert als timestamptz NULL", async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'entries' AND column_name = 'pinned_at'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].data_type).toBe("timestamp with time zone")
    expect(rows[0].is_nullable).toBe("YES")
  })

  it("Pin: setzt pinned_at, bumpt updated_at, lässt revision_id unverändert", async () => {
    const id = await insertEntry()
    const before = await entryRow(id)

    const res = await doPin(id, { pinned: true })
    expect(res.status).toBe(200)

    const after = await entryRow(id)
    expect(after.pinned_at).not.toBeNull()
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
    // Pin ist Metadatum: revision_id bleibt — sonst produziert der nächste
    // Text-Edit des anderen Geräts eine unnötige Konfliktkopie.
    expect(after.revision_id).toBe(before.revision_id)
  })

  it("Unpin: löscht pinned_at, bumpt updated_at erneut, revision_id bleibt", async () => {
    const id = await insertEntry()
    await doPin(id, { pinned: true })
    const pinned = await entryRow(id)

    const res = await doPin(id, { pinned: false })
    expect(res.status).toBe(200)

    const after = await entryRow(id)
    expect(after.pinned_at).toBeNull()
    expect(after.updated_at.getTime()).toBeGreaterThan(pinned.updated_at.getTime())
    expect(after.revision_id).toBe(pinned.revision_id)
  })

  it("Idempotenz: wiederholter Pin antwortet 200, bumpt updated_at aber NICHT erneut (keine leeren Feed-Events)", async () => {
    const id = await insertEntry()
    await doPin(id, { pinned: true })
    const first = await entryRow(id)

    const res = await doPin(id, { pinned: true })
    expect(res.status).toBe(200)

    const second = await entryRow(id)
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime())
    expect(second.pinned_at?.getTime()).toBe(first.pinned_at?.getTime())
  })

  it("404 bei unbekanntem und bei tombstoned Eintrag", async () => {
    expect((await doPin(MISSING_ID, { pinned: true })).status).toBe(404)
    const tombstoned = await insertEntry(true)
    expect((await doPin(tombstoned, { pinned: true })).status).toBe(404)
  })

  it("400 bei ungültigem Body", async () => {
    const id = await insertEntry()
    expect((await doPin(id, { pinned: "yes" })).status).toBe(400)
    expect((await doPin(id, {})).status).toBe(400)
  })

  it("Feed: getChangesSince liefert pinnedAt mit (gesetzt und wieder NULL)", async () => {
    const id = await insertEntry()
    await doPin(id, { pinned: true })

    const page1 = await syncDb.getChangesSince("1970-01-01T00:00:00.000Z", null, null, 50)
    const pinnedEntry = page1.entries.find((e) => e.id === id)
    expect(pinnedEntry?.pinnedAt).toEqual(expect.any(String))

    await doPin(id, { pinned: false })
    const page2 = await syncDb.getChangesSince("1970-01-01T00:00:00.000Z", null, null, 50)
    const unpinnedEntry = page2.entries.find((e) => e.id === id)
    expect(unpinnedEntry?.pinnedAt).toBeNull()
  })

  it("Sync-Upsert überschreibt pinned_at NIE — auch bei LWW-Gewinn des Clients", async () => {
    const id = await insertEntry()
    await doPin(id, { pinned: true })
    const pinned = await entryRow(id)

    const result = await syncDb.upsertEntries([
      {
        id,
        journalId,
        text: "edited on another device",
        createdAt: "2026-08-01T10:00:00.000Z",
        // Weit in der Zukunft relativ zur Server-Zeile → Client gewinnt LWW.
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
        revisionId: pinned.revision_id,
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
      },
    ])
    expect(result.accepted).toContain(id)

    const after = await entryRow(id)
    expect(after.pinned_at?.getTime()).toBe(pinned.pinned_at?.getTime())
  })

  it("Online-Edit (PUT /api/entries/[id]) lässt pinned_at ebenfalls stehen", async () => {
    const id = await insertEntry()
    await doPin(id, { pinned: true })
    const pinned = await entryRow(id)

    const entryRoutes = await import("../src/app/api/entries/[id]/route")
    const res = await entryRoutes.PUT(
      new NextRequest(`http://localhost/api/entries/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          text: "edited online",
          journalId,
          createdAt: "2026-08-01T10:00:00.000Z",
          starred: false,
          tags: [],
        }),
      }),
      { params: Promise.resolve({ id }) }
    )
    expect(res.status).toBe(200)

    const after = await entryRow(id)
    expect(after.pinned_at?.getTime()).toBe(pinned.pinned_at?.getTime())
  })

  it("Zod: UpsertRequestSchema lässt ein client-geliefertes pinnedAt nicht durch (Schutzschicht 2)", () => {
    const parsed = UpsertRequestSchema.parse({
      entries: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          journalId: "10000000-0000-4000-8000-000000000001",
          text: "synthetic",
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
          revisionId: "30000000-0000-4000-8000-000000000001",
          pinnedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    })
    expect("pinnedAt" in parsed.entries[0]).toBe(false)
  })
})
