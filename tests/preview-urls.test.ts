/**
 * Object-URL-Buchhaltung (preview-urls.ts).
 *
 * Vorher lebte diese Logik in pending-media-preview.ts, das realIDBAdapter
 * importiert und deshalb unter vitest/node nicht ladbar ist — der komplette
 * Lebenszyklus (Revoke, Doppel-Revoke, Fallback) war ungetestet.
 *
 * Synthetische Daten, URL.* wird gestubbt.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  createPreviewUrl,
  revokePreviewUrls,
  clearPreviewUrlCache,
} from "../src/lib/sync/preview-urls"

function stubUrl(over: Partial<Record<"createObjectURL" | "revokeObjectURL", unknown>> = {}) {
  const created: Blob[] = []
  const revoked: string[] = []
  let n = 0
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => {
      created.push(b)
      return `blob:synthetic-${++n}`
    },
    revokeObjectURL: (u: string) => revoked.push(u),
    ...over,
  })
  return { created, revoked }
}

afterEach(() => vi.unstubAllGlobals())

describe("createPreviewUrl", () => {
  it("liefert die Object-URL des Blobs", () => {
    stubUrl()
    expect(createPreviewUrl(new Blob(["x"]))).toBe("blob:synthetic-1")
  })

  it("liefert '' statt zu werfen, wenn createObjectURL fehlt", () => {
    stubUrl({ createObjectURL: undefined })
    expect(createPreviewUrl(new Blob(["x"]))).toBe("")
  })

  it("liefert '' statt zu werfen, wenn createObjectURL wirft", () => {
    stubUrl({
      createObjectURL: () => {
        throw new Error("synthetic refusal")
      },
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(createPreviewUrl(new Blob(["x"]))).toBe("")
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("revokePreviewUrls", () => {
  it("revoked jede URL und leert das Array", () => {
    const { revoked } = stubUrl()
    const urls = ["blob:a", "blob:b"]
    revokePreviewUrls(urls)
    expect(revoked).toEqual(["blob:a", "blob:b"])
    expect(urls).toHaveLength(0)
  })

  it("ist doppelt aufrufbar, ohne doppelt zu revoken", () => {
    const { revoked } = stubUrl()
    const urls = ["blob:a"]
    revokePreviewUrls(urls)
    revokePreviewUrls(urls)
    expect(revoked).toEqual(["blob:a"])
  })

  it("übersteht ein werfendes revokeObjectURL und leert trotzdem", () => {
    stubUrl({
      revokeObjectURL: () => {
        throw new Error("already revoked")
      },
    })
    const urls = ["blob:a", "blob:b"]
    expect(() => revokePreviewUrls(urls)).not.toThrow()
    expect(urls).toHaveLength(0)
  })
})

describe("clearPreviewUrlCache", () => {
  it("revoked alle Cache-Werte und leert die Map", () => {
    const { revoked } = stubUrl()
    const cache = new Map([
      ["outbox-1", "blob:a"],
      ["outbox-2", "blob:b"],
    ])
    clearPreviewUrlCache(cache)
    expect(revoked.sort()).toEqual(["blob:a", "blob:b"])
    expect(cache.size).toBe(0)
  })
})
