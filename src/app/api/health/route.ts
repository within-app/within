import { NextResponse } from "next/server";
import { Client } from "pg";

export const dynamic = "force-dynamic";

export async function GET() {
  const sha = process.env.GIT_SHA ?? "unknown";
  // Own short-lived client, never the pool: if Postgres accepts connections
  // but does not answer, a pooled SELECT 1 would park on a slot every 10s
  // and exhaust all 10 slots within ~100s.
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch {
    // Docker healthcheck (wget) exits non-zero on 503 → container shows
    // "unhealthy" (status badge + start order; Compose restarts nothing on it).
    return NextResponse.json({ status: "db_down", sha }, { status: 503 });
  } finally {
    await client.end().catch(() => {});
  }
  return NextResponse.json({ status: "ok", sha });
}
