/**
 * readFileHead liest nur die Kopfbytes einer Datei — die Grundlage der
 * PDF-Inhaltsprüfung (2026-10-30). Echte Dateien im Scratch-Verzeichnis,
 * damit die Kette Datei → Kopf → isPdfHeader einmal ohne Mock belegt ist.
 * Synthetic data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readFileHead } from "@/lib/upload-stream"
import { isPdfHeader, PDF_HEADER_BYTES } from "@/lib/upload-security"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "within-read-file-head-"))
  writeFileSync(join(dir, "ok.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x20)]))
  writeFileSync(join(dir, "short.pdf"), Buffer.from("%PD"))
  writeFileSync(join(dir, "empty.pdf"), Buffer.alloc(0))
  writeFileSync(join(dir, "html.pdf"), Buffer.from("<!doctype html>"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("readFileHead + isPdfHeader", () => {
  it("reads exactly the requested number of bytes from a real PDF header", async () => {
    const head = await readFileHead(join(dir, "ok.pdf"), PDF_HEADER_BYTES)
    expect(head.byteLength).toBe(PDF_HEADER_BYTES)
    expect(Buffer.from(head).toString()).toBe("%PDF-")
    expect(isPdfHeader(head)).toBe(true)
  })

  it("a file shorter than the header is not a PDF (bytesRead < 5)", async () => {
    const head = await readFileHead(join(dir, "short.pdf"), PDF_HEADER_BYTES)
    expect(head.byteLength).toBe(3)
    expect(isPdfHeader(head)).toBe(false)
  })

  it("an empty file is not a PDF", async () => {
    const head = await readFileHead(join(dir, "empty.pdf"), PDF_HEADER_BYTES)
    expect(head.byteLength).toBe(0)
    expect(isPdfHeader(head)).toBe(false)
  })

  it("HTML with a .pdf name is not a PDF", async () => {
    expect(isPdfHeader(await readFileHead(join(dir, "html.pdf"), PDF_HEADER_BYTES))).toBe(false)
  })

  it("a missing file rejects (the caller treats that as a failed check)", async () => {
    await expect(readFileHead(join(dir, "missing.pdf"), PDF_HEADER_BYTES)).rejects.toThrow()
  })
})
