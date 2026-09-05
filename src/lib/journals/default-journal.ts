import { db } from "@/lib/db"

export const DEFAULT_JOURNAL_NAME = "Journal"
export const DEFAULT_JOURNAL_COLOR = "#007AFF"

/**
 * Creates one journal when the installation has none yet (first start), so
 * a new user can write immediately. Idempotent: does nothing once any journal
 * exists — also after the user renamed or replaced the default one.
 * Returns true when a journal was created.
 */
export async function ensureDefaultJournal(): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journals (name, color)
     SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM journals)
     RETURNING id`,
    [DEFAULT_JOURNAL_NAME, DEFAULT_JOURNAL_COLOR]
  )
  return rows.length > 0
}
