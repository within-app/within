/**
 * Sicherer interner Redirect.
 *
 * Der frühere Guard (startsWith("/") && !startsWith("//")) war per Backslash
 * umgehbar: "/\evil.example" beginnt mit einem einzelnen "/", aber die
 * WHATWG-URL-Auflösung normalisiert Backslashes zu Slashes — daraus wird
 * https://evil.example/. Ein Angreifer-Link ?from=/\evil.example leitete nach
 * erfolgreichem Login auf eine Fremd-Origin (Phishing) weiter.
 */

/** True nur für same-origin-relative Pfade: genau ein führender Slash,
 *  zweites Zeichen weder Slash noch Backslash, nirgends ein Backslash. */
export function isSafeInternalRedirect(path: string): boolean {
  if (!path.startsWith("/")) return false
  if (path.includes("\\")) return false
  if (path.length > 1 && path[1] === "/") return false
  return true
}
