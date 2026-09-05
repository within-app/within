import { readFileSync } from "fs"
import { join } from "path"
import { db } from "@/lib/db"
import { logError } from "@/lib/logger"

const MAX_RETRIES = 30
const RETRY_DELAY_MS = 2000

// Postgres error codes and Node.js error codes that indicate the database
// server is not up yet. These are worth retrying. Any other error (e.g. a
// permanent DDL error such as 42P17) must abort immediately — burning 30×2s
// on a deterministic failure wastes startup time and masks the real cause.
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", // server not started / port not open
  "ECONNRESET",   // connection dropped mid-connect
  "ETIMEDOUT",    // connection attempt timed out
  "EHOSTUNREACH", // host not reachable during startup
  "57P03",        // cannot_connect_now — Postgres is starting up
])

function isTransient(err: unknown): boolean {
  if (err && typeof err === "object") {
    return TRANSIENT_CODES.has((err as { code?: string }).code ?? "")
  }
  return false
}

export async function runMigrations(): Promise<void> {
  const schemaPath = join(process.cwd(), "src", "lib", "db", "schema.sql")
  const schema = readFileSync(schemaPath, "utf-8")

  console.log("[db] Connecting to database…")

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await db.query(schema)
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
      console.log(
        `[db] DB not ready yet (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS / 1000}s…`
      )
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}
