import { NextRequest, NextResponse } from "next/server"
import { logError } from "@/lib/logger"
import { dbUnavailableResponse } from "@/lib/env"

/**
 * GET /api/entries/[id]/conflicts — Konfliktkopien eines Eintrags.
 *
 * sync_conflict_copies wird von PUT /api/entries/[id] und dem Sync-Upsert
 * beschrieben, wurde aber bisher von keinem Endpoint gelesen —
 * die gesicherten Verliererversionen waren für den Nutzer unsichtbar
 * (sichtbar machen statt still sammeln).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(
      `SELECT id, revision_id, text, created_at, updated_at, starred,
              location_name, tags, saved_at
       FROM sync_conflict_copies
       WHERE entry_id = $1
       ORDER BY saved_at DESC
       LIMIT 20`,
      [id]
    )
    return NextResponse.json({
      conflicts: rows.map((r) => ({
        id: r.id,
        revisionId: r.revision_id,
        text: r.text,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
        starred: r.starred,
        locationName: r.location_name,
        tags: r.tags ?? [],
        savedAt: new Date(r.saved_at).toISOString(),
      })),
    })
  } catch (error) {
    logError("[GET /api/entries/[id]/conflicts] Error:", error)
    return NextResponse.json(
      { error: "Konfliktkopien konnten nicht geladen werden", code: "conflicts_load_failed" },
      { status: 500 }
    )
  }
}
