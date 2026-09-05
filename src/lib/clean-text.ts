/**
 * cleanText — sanitise raw DayOne markdown before storing it.
 *
 * DayOne exports two classes of noise that must be stripped / unescaped:
 *
 * 1. Embedded-photo references inserted by the iOS client:
 *      ![](dayone-moment://<ID>)
 *    These are uppercase hex UUIDs in practice, but the `/i` flag guards
 *    against lowercase variants.
 *
 * 2. Markdown backslash-escapes that DayOne writes for every special char —
 *    e.g. `\.` × 44, `\(` × 1, `\)` × 1 in a real export.
 *    We unescape the full CommonMark backslash-escapable set so rendered text
 *    shows no stray backslashes.
 */
export function cleanText(text: string): string {
  return text
    // Remove DayOne embedded-photo references (case-insensitive for robustness)
    .replace(/!\[\]\(dayone-moment:\/\/[a-z0-9]+\)/gi, "")
    // Unescape full DayOne / CommonMark backslash-escape set
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1")
    .trim()
}
