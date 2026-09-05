import { z } from "zod"
import { NextResponse } from "next/server"

export function validationError(result: { success: false; error: z.ZodError }): NextResponse {
  const errors = result.error.issues.map((i) => ({
    field: i.path.map(String).join("."),
    message: i.message,
  }))
  return NextResponse.json({ error: "Ungültige Eingabedaten", code: "validation_error", details: errors }, { status: 400 })
}

/** Parses the JSON body, or answers the 400 `invalid_json` every write route uses. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return NextResponse.json({ error: "Ungültiges JSON", code: "invalid_json" }, { status: 400 })
  }
}
