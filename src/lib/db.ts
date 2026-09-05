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
