import type { APIRequestContext } from "@playwright/test"

/**
 * Ensures ≥ `minEntries` synthetic entries exist in the QA-Synthetic journal.
 * Calls the /api/test/seed endpoint which is only enabled in non-production builds.
 *
 * Tages-Karte (03.09.2026): der Seed-Endpunkt legt Einträge seitdem 24h statt
 * 3h auseinander an (1 Eintrag/UTC-Tag) — sonst bestünde das QA-Journal nur
 * noch aus Tages-Karten, und Specs, die eine `entry-card` zählen/erwarten,
 * wären nicht mehr prüfbar. `ensureEntries` seedet bei bereits ≥ `minEntries`
 * vorhandenen Einträgen NICHT neu (Zeile 17f. unten) — ein VOR dem 03.09.2026
 * geseedetes QA-Synthetic-Journal (noch im 3h-Abstand, also mit Tages-Karten)
 * muss daher einmalig manuell gelöscht werden: `GET /api/journals` → das
 * Journal namens "QA-Synthetic" per `DELETE /api/journals/<id>` entfernen,
 * danach seedet der nächste `ensureEntries`-Aufruf frisch im 24h-Abstand.
 *
 * Returns the journalId that was seeded, or throws if seeding fails.
 */
export async function ensureEntries(
  request: APIRequestContext,
  minEntries = 1000
): Promise<string> {
  const res = await request.post("/api/test/seed", {
    data: { count: minEntries },
  })

  if (res.status() === 403) {
    throw new Error(
      "POST /api/test/seed returned 403 — this endpoint is disabled in production.\n" +
        "Run E2E tests against a non-production (NODE_ENV=development or NODE_ENV=test) instance."
    )
  }

  if (!res.ok()) {
    const body = await res.text()
    throw new Error(`Seed endpoint failed (${res.status()}): ${body}`)
  }

  const data = (await res.json()) as { journalId: string; seeded: number; existing: number }
  console.log(
    `[seed] journal=${data.journalId} existing=${data.existing} seeded=${data.seeded} total=${data.existing + data.seeded}`
  )
  return data.journalId
}
