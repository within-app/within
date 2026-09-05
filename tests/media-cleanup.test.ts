/**
 * deleteMediaFile: security exceptions must propagate (throw),
 * not be silently swallowed by a broad catch that returns false.
 *
 * The correct security contract:
 * - Path traversal → throws "Invalid media path" (caller handles → 400, no DB deletion)
 * - ENOENT (file already absent) → resolves silently (desired state achieved)
 * - Other FS errors → propagate to caller
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs/promises before importing the module under test
vi.mock("fs/promises", () => ({
  unlink: vi.fn(),
}))

import { unlink } from "fs/promises"
import { deleteMediaFile } from "../src/lib/media-cleanup"

const CWD = "/fakeapp"
const VALID_REL = "media/uuid-abc/photo.jpg"
const TRAVERSAL_REL = "media/uuid/../../etc/passwd"
const SIBLING_REL = "media-backup/secret.txt"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("deleteMediaFile — security exceptions propagate", () => {
  it("throws 'Invalid media path' on a ../ traversal — does NOT return false silently", async () => {
    await expect(deleteMediaFile(CWD, TRAVERSAL_REL)).rejects.toThrow("Invalid media path")
    expect(unlink).not.toHaveBeenCalled()
  })

  it("throws on sibling-directory path (CWE-22 case)", async () => {
    await expect(deleteMediaFile(CWD, SIBLING_REL)).rejects.toThrow("Invalid media path")
    expect(unlink).not.toHaveBeenCalled()
  })

  it("throws on path resolving to exactly the base directory", async () => {
    await expect(deleteMediaFile(CWD, "media")).rejects.toThrow("Invalid media path")
    expect(unlink).not.toHaveBeenCalled()
  })
})

describe("deleteMediaFile — benign ENOENT silently ignored", () => {
  it("calls unlink with the resolved absolute path for a valid path", async () => {
    vi.mocked(unlink).mockResolvedValue(undefined)
    await expect(deleteMediaFile(CWD, VALID_REL)).resolves.not.toThrow()
    expect(unlink).toHaveBeenCalledWith("/fakeapp/public/media/uuid-abc/photo.jpg")
  })

  it("resolves without error when unlink throws ENOENT (file already gone)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    vi.mocked(unlink).mockRejectedValue(enoent)
    await expect(deleteMediaFile(CWD, VALID_REL)).resolves.not.toThrow()
  })

  it("propagates unexpected FS errors (non-ENOENT) to the caller", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" })
    vi.mocked(unlink).mockRejectedValue(eperm)
    await expect(deleteMediaFile(CWD, VALID_REL)).rejects.toThrow("EPERM")
  })
})
