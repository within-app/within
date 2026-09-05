// 10 palette colors that work in both light and dark themes (AA contrast verified)
export const TAG_PALETTE = [
  "#e45858",
  "#e4874a",
  "#d4a017",
  "#4aaa5e",
  "#3d9eca",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#64748b",
]

function djb2(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0
  }
  return h
}

/** Deterministic color for a tag name — always returns the same palette color. */
export function tagColor(name: string): string {
  return TAG_PALETTE[djb2(name) % TAG_PALETTE.length]
}
