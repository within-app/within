/**
 * Combines Web Share Target params into a pre-filled entry draft.
 * Pure function — no DOM or Next.js dependency so it is directly testable.
 */

interface ShareParams {
  title?: string
  text?: string
  url?: string
}

/**
 * Combine title, text, and url from a Web Share Target request into a single
 * string suitable for pre-filling the journal entry editor.
 * Parts are joined with double newlines; blank/whitespace-only parts are omitted.
 */
export function buildShareDraft({ title, text, url }: ShareParams): string {
  const parts = [title, text, url]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
  return parts.join("\n\n")
}
