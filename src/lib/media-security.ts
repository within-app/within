import { resolve, join, sep } from "path"

/**
 * Returns true when `segments` resolve to a path strictly inside `base`.
 * Used to prevent path-traversal attacks on the media route.
 */
export function isPathSafe(base: string, segments: string[]): boolean {
  const resolved = resolve(join(base, ...segments))
  return resolved.startsWith(base + sep)
}

/**
 * Resolve `relPath` to an absolute path and assert it is strictly inside
 * `<cwd>/public/media/`. Checks segment boundary (base + sep) so a sibling
 * directory whose name starts with "media" (e.g. media-backup) is rejected.
 * Throws on any path outside the media tree.
 */
export function safeMediaPath(cwd: string, relPath: string): string {
  const base = join(cwd, "public", "media")
  const rel = relPath.startsWith("/") ? relPath.slice(1) : relPath
  const resolved = resolve(join(cwd, "public"), rel)
  if (!resolved.startsWith(base + sep)) {
    throw new Error("Invalid media path")
  }
  return resolved
}
