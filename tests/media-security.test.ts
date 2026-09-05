import { describe, it, expect } from "vitest"
import { isPathSafe, safeMediaPath } from "../src/lib/media-security"
import { resolve } from "path"

const BASE = resolve("/srv/media")

describe("isPathSafe — path-traversal guard", () => {
  it("allows a normal filename", () => {
    expect(isPathSafe(BASE, ["photo.jpg"])).toBe(true)
  })

  it("allows a nested path", () => {
    expect(isPathSafe(BASE, ["2024", "vacation", "img.webp"])).toBe(true)
  })

  it("blocks ../ traversal", () => {
    expect(isPathSafe(BASE, ["..", "etc", "passwd"])).toBe(false)
  })

  it("blocks traversal that starts inside base but escapes", () => {
    expect(isPathSafe(BASE, ["sub", "..", "..", "etc"])).toBe(false)
  })

  it("blocks path that exactly equals the base (no trailing sep)", () => {
    // resolve(join(BASE)) === BASE, does not start with BASE + sep
    expect(isPathSafe(BASE, [])).toBe(false)
  })

  it("does not match a sibling directory that starts with the same prefix", () => {
    // e.g. /srv/media-private should NOT be accepted
    // segments would need to resolve there via traversal
    expect(isPathSafe(BASE, ["..", "media-private", "secret.txt"])).toBe(false)
  })
})

describe("safeMediaPath — CWE-22 prefix+separator guard", () => {
  const CWD = "/fakeapp"

  it("accepts a valid media path under public/media/", () => {
    const result = safeMediaPath(CWD, "media/uuid-abc/photo.jpg")
    expect(result).toBe("/fakeapp/public/media/uuid-abc/photo.jpg")
  })

  it("accepts a valid media path with leading slash stripped", () => {
    const result = safeMediaPath(CWD, "/media/uuid-abc/thumb.webp")
    expect(result).toBe("/fakeapp/public/media/uuid-abc/thumb.webp")
  })

  it("rejects a sibling directory that shares the 'media' string prefix (CWE-22 core case)", () => {
    // 'media-backup/x.jpg' resolves to /fakeapp/public/media-backup/x.jpg
    // Old guard: startsWith('/fakeapp/public/media') → TRUE (bug)
    // New guard: startsWith('/fakeapp/public/media/') → FALSE (correct)
    expect(() => safeMediaPath(CWD, "media-backup/x.jpg")).toThrow("Invalid media path")
  })

  it("rejects a path that resolves to exactly the base directory", () => {
    // resolve(join(cwd, 'public'), 'media') === base — no file, should be rejected
    expect(() => safeMediaPath(CWD, "media")).toThrow("Invalid media path")
  })

  it("rejects path traversal out of public/media/", () => {
    expect(() => safeMediaPath(CWD, "media/uuid/../../etc/passwd")).toThrow("Invalid media path")
  })

  it("rejects path traversal to a completely different directory", () => {
    expect(() => safeMediaPath(CWD, "../secrets/key.pem")).toThrow("Invalid media path")
  })
})
