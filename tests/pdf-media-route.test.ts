/**
 * PDF-Anhänge (2026-10-30): Auslieferung über die Medien-Route.
 *
 * Ein PDF wird vom Browser in dessen eigenem Viewer geöffnet (neuer Tab).
 * Dafür muss die Route den Typ korrekt benennen (application/pdf statt
 * octet-stream — sonst bietet der Browser nur den Download an), Range-
 * Requests erlauben (Chrome/Firefox laden große PDFs stückweise) und
 * `inline` signalisieren. Alles andere (no-store, Pfad-Guard) bleibt wie
 * für Fotos und Videos.
 *
 * Nur synthetische Daten — die Datei trägt lediglich einen PDF-Kopf.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { NextRequest } from "next/server"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))

import { GET as mediaGET } from "../src/app/media/[...path]/route"

const SYNTH_DIR = join(process.cwd(), "public", "media", "__vitest-pdf-route__")
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x20)])

beforeAll(() => {
  mkdirSync(SYNTH_DIR, { recursive: true })
  writeFileSync(join(SYNTH_DIR, "synth-original.pdf"), PDF_BYTES)
  writeFileSync(join(SYNTH_DIR, "synth.jpg"), Buffer.from("SYNTHETIC_JPEG_NOT_REAL"))
})

afterAll(() => {
  rmSync(SYNTH_DIR, { recursive: true, force: true })
})

function mediaParams(...path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe("Medien-Route: PDF", () => {
  it("liefert application/pdf, inline, mit Range-Unterstützung und no-store", async () => {
    const res = await mediaGET(
      new NextRequest("http://localhost/media/__vitest-pdf-route__/synth-original.pdf"),
      mediaParams("__vitest-pdf-route__", "synth-original.pdf")
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("content-disposition")).toMatch(/^inline/)
    expect(res.headers.get("content-disposition")).toMatch(/synth-original\.pdf/)
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("content-length")).toBe(String(PDF_BYTES.length))
    expect((await res.arrayBuffer()).byteLength).toBe(PDF_BYTES.length)
  })

  it("beantwortet einen Range-Request mit 206 und dem angeforderten Ausschnitt", async () => {
    const req = new NextRequest("http://localhost/media/__vitest-pdf-route__/synth-original.pdf", {
      headers: { range: "bytes=0-8" },
    })
    const res = await mediaGET(req, mediaParams("__vitest-pdf-route__", "synth-original.pdf"))
    expect(res.status).toBe(206)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("content-range")).toBe(`bytes 0-8/${PDF_BYTES.length}`)
    expect(await res.text()).toBe("%PDF-1.7\n")
  })

  it("Bilder bleiben unverändert: kein Content-Disposition, keine Ranges", async () => {
    const res = await mediaGET(
      new NextRequest("http://localhost/media/__vitest-pdf-route__/synth.jpg"),
      mediaParams("__vitest-pdf-route__", "synth.jpg")
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/jpeg")
    expect(res.headers.get("content-disposition")).toBeNull()
    expect(res.headers.get("accept-ranges")).toBe("none")
    // Body konsumieren, damit der Dateistream nicht nach dem Aufräumen öffnet.
    await res.arrayBuffer()
  })
})
