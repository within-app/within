/**
 * PDF-Anhänge (2026-10-30) — Klickpfad im echten Browser.
 *
 * Gegen den lokalen Dev-Stack laufen lassen:
 *   docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build -d
 *   E2E_BASE_URL=http://localhost:4000 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/pdf-attachment.spec.ts
 *
 *   Fall 1: Im Editor ein PDF anhängen → Kachel mit Name; nach dem Speichern
 *           zeigt die Einzelansicht die Anhang-Zeile mit Name und Größe.
 *   Fall 2: „Öffnen" liefert das PDF in einem neuen Tab als application/pdf,
 *           „Herunterladen" trägt den Dateinamen mit .pdf-Endung.
 *   Fall 3: Eine Datei mit PDF-Namen, aber fremdem Inhalt, wird abgelehnt und
 *           hinterlässt keine Kachel.
 *
 * Nur synthetische Inhalte — das PDF ist ein Minimal-Dokument ohne Text.
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

/** Kleinstes gültiges PDF (ein leeres Blatt) — nur der Kopf zählt für Within. */
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n" +
  "trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n"
)

const MARKER = `e2e-pdf-${Date.now()}`

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 15_000 })
}

async function firstJournalId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/journals")
  expect(res.ok()).toBeTruthy()
  const journals = (await res.json()) as Array<{ id: string }>
  expect(journals.length).toBeGreaterThan(0)
  return journals[0].id
}

async function createEntry(request: APIRequestContext, journalId: string, text: string): Promise<string> {
  const res = await request.post("/api/entries", { data: { text, journalId, starred: false, tags: [] } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { id: string }).id
}

test.describe("PDF-Anhänge", () => {
  test("Fall 1 — PDF im Editor anhängen, speichern, Zeile in der Einzelansicht", async ({ page, request }) => {
    const journalId = await firstJournalId(request)
    const entryId = await createEntry(request, journalId, `${MARKER} Fall 1`)

    await openApp(page)
    await page.goto(`/entry/${entryId}/edit`)
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const input = page.locator('input[type="file"]')
    await expect(input).toHaveAttribute("accept", /application\/pdf/)
    await input.setInputFiles({ name: "Synth Vertrag.pdf", mimeType: "application/pdf", buffer: MINIMAL_PDF })

    // Kachel im Editor: Dokument-Symbol + Name
    await expect(page.getByText("Synth Vertrag.pdf").first()).toBeVisible({ timeout: 15_000 })

    // Serverseitig hängt das PDF am Eintrag — mit Name und Größe
    await expect.poll(async () => {
      const res = await request.get(`/api/entries/${entryId}`)
      const data = (await res.json()) as { media: Array<{ type: string; originalName?: string | null; sizeBytes?: number | null }> }
      const pdf = data.media.find((m) => m.type === "pdf")
      return pdf ? `${pdf.originalName}|${pdf.sizeBytes}` : null
    }, { timeout: 15_000 }).toBe(`Synth Vertrag.pdf|${MINIMAL_PDF.length}`)

    // Einzelansicht: Anhang-Zeile mit Name, Größe und beiden Aktionen
    await page.goto(`/entry/${entryId}`)
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)
    await expect(page.getByText("Synth Vertrag.pdf")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/\d+ B · PDF/)).toBeVisible()
    await expect(page.getByRole("link", { name: /Synth Vertrag\.pdf in neuem Tab öffnen/ })).toBeVisible()
    await expect(page.getByRole("link", { name: /Synth Vertrag\.pdf herunterladen/ })).toHaveAttribute("download", "Synth Vertrag.pdf")
  })

  test("Fall 2 — Öffnen liefert application/pdf im neuen Tab", async ({ page, request, context }) => {
    const journalId = await firstJournalId(request)
    const entryId = await createEntry(request, journalId, `${MARKER} Fall 2`)
    const up = await request.post(`/api/upload?entryId=${entryId}&fileName=${encodeURIComponent("Scan")}`, {
      headers: { "content-type": "application/pdf" },
      data: MINIMAL_PDF,
    })
    expect(up.status()).toBe(201)
    const uploaded = (await up.json()) as { filePath: string; type: string; originalName: string | null }
    expect(uploaded.type).toBe("pdf")
    expect(uploaded.originalName).toBe("Scan")

    await openApp(page)
    await page.goto(`/entry/${entryId}`)
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const open = page.getByRole("link", { name: /Scan in neuem Tab öffnen/ })
    await expect(open).toBeVisible({ timeout: 15_000 })
    await expect(open).toHaveAttribute("target", "_blank")
    await expect(open).toHaveAttribute("rel", /noopener/)
    // Day-One-Name ohne Endung → Download trägt .pdf
    await expect(page.getByRole("link", { name: /Scan herunterladen/ })).toHaveAttribute("download", "Scan.pdf")

    // Der neue Tab bekommt das PDF mit dem richtigen Content-Type. Auf Kontext-
    // Ebene lauschen und VOR dem Klick registrieren — die Antwort kommt mit dem
    // ersten Request des neuen Tabs, ein Listener auf dem Tab selbst wäre zu spät.
    // (Headless Chromium lädt PDFs statt sie anzuzeigen; die Antwort-Header sind
    // in beiden Fällen dieselben.)
    const [res] = await Promise.all([
      context.waitForEvent("response", (r) => r.url().endsWith(uploaded.filePath)),
      open.click(),
    ])
    expect(res.status()).toBe(200)
    expect(res.headers()["content-type"]).toBe("application/pdf")
    expect(res.headers()["content-disposition"]).toMatch(/^inline/)
    expect(res.headers()["x-frame-options"]).toBe("DENY")
  })

  test("Fall 3 — fremder Inhalt mit PDF-Namen wird abgelehnt, keine Kachel bleibt", async ({ page, request }) => {
    const journalId = await firstJournalId(request)
    const entryId = await createEntry(request, journalId, `${MARKER} Fall 3`)

    await openApp(page)
    await page.goto(`/entry/${entryId}/edit`)
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const input = page.locator('input[type="file"]')
    await input.setInputFiles({ name: "getarnt.pdf", mimeType: "application/pdf", buffer: Buffer.from("<!doctype html><script>alert(1)</script>") })

    // Der Uploader legt eine abgelehnte Datei in die Outbox und zeigt den Serverfehler auf der Kachel —
    // oder verwirft sie; in beiden Fällen darf serverseitig nichts hängen.
    await expect.poll(async () => {
      const res = await request.get(`/api/entries/${entryId}`)
      const data = (await res.json()) as { media: Array<{ type: string }> }
      return data.media.filter((m) => m.type === "pdf").length
    }, { timeout: 10_000 }).toBe(0)
    await expect(page.getByText(/Keine gültige PDF-Datei|Upload fehlgeschlagen|getarnt\.pdf/).first()).toBeVisible({ timeout: 15_000 })
  })
})
