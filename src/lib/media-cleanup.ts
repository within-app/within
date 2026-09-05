import { unlink } from "fs/promises"
import { safeMediaPath } from "@/lib/media-security"

/**
 * Delete a media file at `relPath` under `<cwd>/public/media/`.
 *
 * Security exceptions from safeMediaPath propagate to the caller so the
 * DELETE route can reject the request (400) before touching the DB.
 * Benign ENOENT (file already absent) is silently ignored.
 * Other unexpected FS errors propagate.
 */
export async function deleteMediaFile(cwd: string, relPath: string): Promise<void> {
  const absPath = safeMediaPath(cwd, relPath)
  try {
    await unlink(absPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}
