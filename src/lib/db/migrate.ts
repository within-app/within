import { readFileSync } from "fs"
import { join } from "path"
import { DatabaseError } from "pg"
import { db } from "@/lib/db"
import { logError } from "@/lib/logger"

const MAX_RETRIES = 30
const RETRY_DELAY_MS = 2000

// Server answered with one of these SQLSTATEs → Postgres is (re)starting or
// full, worth retrying. Any other SQLSTATE (e.g. a permanent DDL error such
// as 42P17) must abort immediately — burning 30×2s on a deterministic failure
// wastes startup time and masks the real cause.
const TRANSIENT_SQLSTATE = new Set([
  "57P03", // cannot_connect_now — Postgres is starting up
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "53300", // too_many_connections
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
])

function isTransient(err: unknown): boolean {
  // Not a DatabaseError = the server never answered (pool connect timeout,
  // ENOTFOUND/EAI_AGAIN, ECONNREFUSED/ECONNRESET, "Connection terminated").
  if (!(err instanceof DatabaseError)) return true
  return TRANSIENT_SQLSTATE.has(err.code ?? "")
}

export async function runMigrations(): Promise<void> {
  const schemaPath = join(process.cwd(), "src", "lib", "db", "schema.sql")
  const schema = readFileSync(schemaPath, "utf-8")

  console.log("[db] Connecting to database…")

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Own client without the pool's statement_timeout (db.ts): GIN indexes
      // and backfill UPDATEs on a big journal may run longer than 120 s.
      // release(true) destroys the client so the changed setting never
      // returns to the pool.
      const client = await db.connect()
      try {
        await client.query("SET statement_timeout = 0")
        await client.query(schema)
      } finally {
        client.release(true)
      }
      console.log("[db] Schema applied successfully")
      return
    } catch (err) {
      if (!isTransient(err)) {
        // Permanent error (DDL failure, syntax error, etc.) — do not retry.
        logError("[db] Migration aborted: non-transient error on attempt " + attempt, err)
        throw err
      }
      if (attempt === MAX_RETRIES) {
        logError("[db] Migration failed after max retries", err)
        throw err
      }
      // Message always: a permanent client-side error without a server
      // answer (bad SSL config, empty password) is retried too — the cause
      // must be visible on the first attempt, not after 30.
      const msg = err instanceof Error ? err.message : String(err)
      console.log(
        `[db] DB not ready yet (attempt ${attempt}/${MAX_RETRIES}): ${msg} — retrying in ${RETRY_DELAY_MS / 1000}s…`
      )
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}
