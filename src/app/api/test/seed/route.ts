import { NextRequest, NextResponse } from "next/server"

// This endpoint only exists in staging / non-production environments.
// It bulk-inserts synthetic journal entries for E2E / visual-regression tests.
// Never call this against real user data — it creates fabricated entries only.
//
// NODE_ENV cannot gate this in the Next.js standalone build: server.js forces
// NODE_ENV=production at runtime regardless of the Docker environment variable.
// Use ENABLE_SEED_ENDPOINT=true (set in docker-compose.dev.yml) instead.
export async function POST(req: NextRequest) {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_SEED_ENDPOINT === "true"
  if (!enabled) {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "No DATABASE_URL configured" }, { status: 500 })
  }

  let count = 1000
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.count === "number" && body.count > 0 && body.count <= 5000) {
      count = body.count
    }
  } catch {
    // use default count
  }

  try {
    const { db } = await import("@/lib/db")

    // Ensure a QA test journal exists
    const { rows: journalRows } = await db.query<{ id: string }>(
      `INSERT INTO journals (name, color)
       VALUES ('QA-Synthetic', '#6B7280')
       ON CONFLICT DO NOTHING
       RETURNING id`
    )
    let journalId: string
    if (journalRows.length > 0) {
      journalId = journalRows[0].id
    } else {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM journals WHERE name = 'QA-Synthetic' LIMIT 1`
      )
      if (rows.length === 0) {
        return NextResponse.json({ error: "Failed to create or find QA journal" }, { status: 500 })
      }
      journalId = rows[0].id
    }

    // Check existing entry count to avoid duplicate seeding
    const { rows: countRows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM entries WHERE journal_id = $1`,
      [journalId]
    )
    const existing = parseInt(countRows[0]?.n ?? "0", 10)
    if (existing >= count) {
      return NextResponse.json({ seeded: 0, existing, journalId, message: "Already seeded" })
    }

    const needed = count - existing
    // Build arrays for UNNEST bulk insert — spread across ~3 years of dates
    const texts: string[] = []
    const dates: string[] = []

    const base = new Date("2024-01-15T10:00:00Z")
    for (let i = 0; i < needed; i++) {
      // Tages-Karte: der Seed muss Einzelkarten liefern, damit
      // die Karten-Budget- und Screenshot-Specs weiter Einzelkarten zählen —
      // Tages-Karten prüft day-preview.spec. 24h Abstand = 1 Eintrag pro UTC-Tag.
      const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000) // 24 hours apart (1/day)
      texts.push(`Synthetic QA entry #${existing + i + 1} — auto-generated, safe to delete`)
      dates.push(d.toISOString())
    }

    await db.query(
      `INSERT INTO entries (journal_id, text, created_at, updated_at, starred)
       SELECT $1::uuid, t, d::timestamptz, NOW(), false
       FROM UNNEST($2::text[], $3::text[]) AS u(t, d)`,
      [journalId, texts, dates]
    )

    return NextResponse.json({ seeded: needed, existing, journalId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
