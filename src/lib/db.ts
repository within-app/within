import { Pool } from "pg"

declare global {

  var __pgPool: Pool | undefined
}

// NOTE: DATABASE_URL must use percent-encoded passwords (e.g. @ → %40, / → %2F).
// pg's native parser (pg-connection-string) handles encoded chars and query
// params such as ?sslmode=require correctly. Do not use raw special chars.
function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Server-side guards: a runaway statement or a stuck transaction must not
    // hold one of the 10 slots forever. Longest legitimate single statement in
    // request handling is the export's full-entries SELECT — seconds on the
    // Pi, so 120 s is generous (the migration opts out, see migrate.ts).
    // Between BEGIN and COMMIT the app only awaits DB calls (no file I/O
    // inside transactions), so 60 s idle-in-transaction is safe.
    // No client-side query_timeout on purpose: pg only drops the query and
    // leaves a socket that is no longer readyForQuery in the pool — the next
    // borrower would inherit that zombie client.
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 60_000,
  })
}

function getPool(): Pool {
  if (global.__pgPool) return global.__pgPool
  const pool = createPool()
  // Without this listener, node-postgres emits idle-connection errors as an
  // unhandled 'error' event → uncaught exception → process crash.
  pool.on("error", (err) => {
    console.error("[db-pool] idle client error:", err)
  })
  return pool
}

// Singleton — prevents too many connections during Next.js hot reload in dev
export const db: Pool = getPool()

if (process.env.NODE_ENV !== "production") {
  global.__pgPool = db
}
