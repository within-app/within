export type ThemeMode = "system" | "light" | "dark"

const CYCLE: ThemeMode[] = ["system", "light", "dark"]

export function nextTheme(current: string | undefined): ThemeMode {
  const idx = CYCLE.indexOf((current ?? "system") as ThemeMode)
  return CYCLE[(idx + 1) % CYCLE.length]
}
