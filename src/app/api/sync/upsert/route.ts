import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { UpsertRequestSchema } from "@/lib/schemas/sync.schema"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError } from "@/lib/logger"
import type { SyncEntry } from "@/lib/sync/types"

export async function POST(req: NextRequest) {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody

  const parsed = UpsertRequestSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)

  try {
    const { upsertEntries } = await import("@/lib/db/sync")
    // Zod nullable().optional() produces `T | null | undefined`; SyncEntry uses `T | null`.
    // The ?? null guards inside upsertEntries safely handle any undefined values.
    const result = await upsertEntries(parsed.data.entries as unknown as SyncEntry[])
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    logError("[POST /api/sync/upsert] Error:", error)
    return NextResponse.json({ error: "Upsert fehlgeschlagen", code: "upsert_failed" }, { status: 503 })
  }
}
