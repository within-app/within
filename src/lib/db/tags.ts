import type { PoolClient } from "pg"
import { logWarn } from "@/lib/logger"

/**
 * Tag-Verknüpfungen eines Eintrags ersetzen (replace-all) — innerhalb der
 * Schreib-Transaktion des Aufrufers (PUT, DELETE-Tombstone, Sync-Upsert).
 * Leere Namen fallen hier raus (der Sync-Pfad liefert Zod-getrimmt, aber
 * ungefiltert). Liefert die IDs der Tags, die der Eintrag dabei verloren hat —
 * Kandidaten für deleteOrphanTags() NACH dem COMMIT.
 */
export async function replaceEntryTags(
  client: PoolClient,
  entryId: string,
  rawNames: string[]
): Promise<string[]> {
  const names = rawNames.map((n) => n.trim()).filter(Boolean)
  const { rows: previous } = await client.query<{ tag_id: string }>(
    `DELETE FROM entry_tags WHERE entry_id = $1 RETURNING tag_id`,
    [entryId]
  )
  const kept = new Set<string>()
  if (names.length > 0) {
    const { rows: tagRows } = await client.query<{ id: string }>(
      `INSERT INTO tags (name) SELECT DISTINCT UNNEST($1::text[])
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [names]
    )
    await client.query(
      `INSERT INTO entry_tags (entry_id, tag_id)
       SELECT $1::uuid, UNNEST($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [entryId, tagRows.map((r) => r.id)]
    )
    for (const r of tagRows) kept.add(r.id)
  }
  return previous.map((r) => r.tag_id).filter((id) => !kept.has(id))
}

/**
 * Löscht aus `ids` die tags-Zeilen, die an keinem Eintrag mehr hängen
 * (Namen gelöschter Einträge sollen nicht in DB/pg_dump belassen bleiben;
 * vorher waren sie nur ausgeblendet).
 *
 * NACH dem COMMIT der Schreib-Transaktion aufrufen, je Tag eine eigene
 * Mini-Transaktion mit genau einer Zeilensperre: Wer nichts hält, während er
 * wartet, kann nicht Teil eines Deadlock-Zyklus sein. Innerhalb der Schreib-
 * Transaktion (Eintragszeile gesperrt, Upsert-Sperren in Plan-Reihenfolge)
 * waren zwei neue Deadlock-Klassen reproduzierbar.
 * Zwei Statements sind tragend: FOR UPDATE wartet auf den ON-CONFLICT-Upsert
 * eines anderen Geräts, das frische DELETE sieht danach dessen Verknüpfung —
 * ein einzelnes DELETE prüfte NOT EXISTS gegen seinen Start-Snapshot (EPQ).
 *
 * intentionally minimal: wirft nie — ein Fehler hier darf einen committeten
 * Save nicht zum 500 machen. Stirbt der Prozess zwischen COMMIT und Aufräumen
 * oder schlägt eine Mini-Transaktion fehl, holt sweepOrphanTags() die Waise
 * nach (Start + täglich, instrumentation.ts); /api/tags blendet sie bis dahin aus.
 */
export async function deleteOrphanTags(client: PoolClient, ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    try {
      await client.query("BEGIN")
      await client.query(`SELECT 1 FROM tags WHERE id = $1 FOR UPDATE`, [id])
      await client.query(
        `DELETE FROM tags t
          WHERE t.id = $1
            AND NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.tag_id = t.id)`,
        [id]
      )
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      // Prod-Logger schreibt nur den Kontext — den Postgres-Code mitgeben.
      const code = (err as { code?: string } | null)?.code ?? "?"
      logWarn(`[tags] Waisen-Aufräumen fehlgeschlagen (code=${code}; Sweep holt nach):`, err)
    }
  }
}

/**
 * Alle aktuell unverknüpften Tags — für Pfade, deren Unlink ein CASCADE ist
 * (Journal löschen) und für den Sweep: erst NACH dem COMMIT lesen, damit auch
 * parallel verknüpfte und mit-kaskadierte Tags im frischen Snapshot erfasst sind.
 */
export async function orphanTagIds(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM tags t WHERE NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.tag_id = t.id)`
  )
  return rows.map((r) => r.id)
}

/**
 * Fail-soft Sweep (Start + täglich, s. instrumentation.ts): Waisen, die der
 * Schreibpfad nicht mehr erreicht hat — Prozess-Tod zwischen COMMIT und
 * Aufräumen, verschluckte Mini-Transaktion, Altbestand. Gleiche Per-Tag-
 * Mechanik wie deleteOrphanTags(); bewusst NICHT in schema.sql: dort wäre ein
 * Sperr-Fehler ein fataler Migrationsfehler, und ein globales
 * `DELETE … NOT EXISTS` prüfte gegen seinen Start-Snapshot.
 */
export async function sweepOrphanTags(): Promise<number> {
  try {
    const { db } = await import("@/lib/db")
    const client = await db.connect()
    try {
      const ids = await orphanTagIds(client)
      await deleteOrphanTags(client, ids)
      if (ids.length > 0) console.log(`[within/tag-sweep] ${ids.length} Waisen-Tag(s) geprüft`)
      return ids.length
    } finally {
      client.release()
    }
  } catch (err) {
    logWarn("[within/tag-sweep] sweep failed:", err)
    return 0
  }
}
