/**
 * CSP Nonce Layout Tests
 *
 * Verifies that:
 * - getNonce() reads x-nonce from next/headers
 * - Returns empty string when header is absent
 *
 * Synthetic data only — no real credentials or journal content.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock next/headers before importing the module under test
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}))

import { headers } from "next/headers"
import { getNonce } from "../src/lib/nonce"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getNonce — x-nonce header reading", () => {
  it("returns the x-nonce header value when present", async () => {
    vi.mocked(headers).mockResolvedValue({
      get: (name: string) => (name === "x-nonce" ? "test-nonce-abc123" : null),
    } as unknown as ReturnType<typeof headers> extends Promise<infer T> ? T : never)

    const nonce = await getNonce()
    expect(nonce).toBe("test-nonce-abc123")
  })

  it("returns empty string when x-nonce header is absent", async () => {
    vi.mocked(headers).mockResolvedValue({
      get: () => null,
    } as unknown as ReturnType<typeof headers> extends Promise<infer T> ? T : never)

    const nonce = await getNonce()
    expect(nonce).toBe("")
  })

  it("returns empty string when x-nonce header is empty", async () => {
    vi.mocked(headers).mockResolvedValue({
      get: (name: string) => (name === "x-nonce" ? "" : null),
    } as unknown as ReturnType<typeof headers> extends Promise<infer T> ? T : never)

    const nonce = await getNonce()
    expect(nonce).toBe("")
  })

  it("forwards a base64url nonce unchanged", async () => {
    const rawNonce = "PPeaZmcP2IlatlaANI5MoA"
    vi.mocked(headers).mockResolvedValue({
      get: (name: string) => (name === "x-nonce" ? rawNonce : null),
    } as unknown as ReturnType<typeof headers> extends Promise<infer T> ? T : never)

    const nonce = await getNonce()
    expect(nonce).toBe(rawNonce)
  })
})
