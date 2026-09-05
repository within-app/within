/**
 * App-Passwort: Klartext in der Umgebung, Hash in der Datenbank.
 *
 * Der Nutzer trägt sein Wunschpasswort als APP_PASSWORD in die Compose-Datei
 * ein. Beim Start hasht die App es selbst (bcrypt) und legt den Hash in
 * app_settings ab. Ein unverändertes Klartext-Passwort wird beim nächsten
 * Start nicht erneut verarbeitet; ein geändertes ersetzt den Hash (die Datei
 * gewinnt); ein aus der Datei entferntes lässt den gespeicherten Hash stehen.
 *
 * APP_PASSWORD_HASH (fertiger bcrypt-Hash in der Umgebung) bleibt als
 * Rückfall für bestehende Installationen; ist beides gesetzt, gilt der aus
 * APP_PASSWORD abgeleitete Hash in der Datenbank.
 */

import bcrypt from "bcryptjs"
import { db } from "@/lib/db"

export const PASSWORD_HASH_KEY = "password_hash"
const BCRYPT_ROUNDS = 12

async function readStoredHash(): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [PASSWORD_HASH_KEY]
  )
  return rows[0]?.value ?? null
}

/**
 * Gleicht APP_PASSWORD mit dem gespeicherten Hash ab. Liefert, was passiert
 * ist — für das Startlog und die Tests.
 */
export async function syncPasswordFromEnv(): Promise<"unset" | "unchanged" | "stored"> {
  const plain = process.env.APP_PASSWORD
  if (!plain) return "unset"
  const stored = await readStoredHash()
  if (stored && (await bcrypt.compare(plain, stored))) return "unchanged"
  const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS)
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [PASSWORD_HASH_KEY, hash]
  )
  return "stored"
}

/** Der Hash, gegen den der Login prüft: Datenbank vor Umgebung; null = nicht konfiguriert. */
export async function getPasswordHash(): Promise<string | null> {
  const stored = await readStoredHash()
  if (stored) return stored
  return process.env.APP_PASSWORD_HASH || null
}
