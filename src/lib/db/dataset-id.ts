/**
 * Datenbestand-Kennung (app_settings.dataset_id).
 *
 * Eine UUID, die den aktuellen Datenbestand des Servers kennzeichnet. Sie
 * wechselt immer dann, wenn der Bestand nicht mehr über den Delta-Sync
 * erreichbar ist: Restore eines Dumps (scripts/backup/restore.sh), Neuaufsetzen
 * (frische DB → neue Kennung aus der Migration) und Journal-Löschung (harter
 * DELETE, kein Tombstone-Pfad). Die Sync-Engine vergleicht die Kennung aus der
 * /api/settings-Probe mit der lokal gemerkten und zieht bei Abweichung alles
 * neu (src/lib/sync/engine.ts).
 *
 * Die UUID entsteht in der Datenbank (gen_random_uuid) — nie aus dem Client.
 */

export const DATASET_ID_KEY = "dataset_id"

/** Pool oder PoolClient — nur query() wird gebraucht. */
interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

/** Legt die Kennung einmalig an (Erststart, Upgrade). Idempotent. */
export async function ensureDatasetId(client: Queryable): Promise<void> {
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, gen_random_uuid()::text, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [DATASET_ID_KEY]
  )
}

/** Setzt eine neue Kennung — jedes Gerät gleicht beim nächsten Sync vollständig neu ab. */
export async function rotateDatasetId(client: Queryable): Promise<void> {
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, gen_random_uuid()::text, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [DATASET_ID_KEY]
  )
}
