// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
// Gemeinsame Theme-Labels für command-palette.tsx und journal-sidebar.tsx (ein Key, zwei Verwender).
const de = {
  light: "Helles Design",
  dark: "Dunkles Design",
  system: "System-Farbschema",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  light: "Light theme",
  dark: "Dark theme",
  system: "System colour scheme",
}

const fr: SectionMessages = {
  light: "Thème clair",
  dark: "Thème sombre",
  system: "Thème système",
}

export const themeMessages = { de, en, fr }
