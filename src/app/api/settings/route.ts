import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { UpdateSettingsSchema } from "@/lib/schemas/settings.schema"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError, logWarn } from "@/lib/logger"

const LOCALE_KEY = "locale"

export async function GET() {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [LOCALE_KEY])
    return NextResponse.json({ locale: rows[0]?.value ?? null })
  } catch (error) {
    logWarn("[GET /api/settings] DB error:", error)
    return dbUnavailableResponse()
  }
}

export async function PUT(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = UpdateSettingsSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [LOCALE_KEY, parsed.data.locale]
    )
    return NextResponse.json({ locale: parsed.data.locale })
  } catch (error) {
    logError("[PUT /api/settings] Error:", error)
    return NextResponse.json(
      { error: "Einstellung konnte nicht gespeichert werden", code: "settings_save_failed" },
      { status: 500 }
    )
  }
}
