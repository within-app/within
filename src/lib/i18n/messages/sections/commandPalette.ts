// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  title: "Befehlspalette",
  searchPlaceholder: "Befehle oder Einträge suchen…",
  noResults: "Keine Ergebnisse.",
  groups: {
    actions: "Aktionen",
    journals: "Journals",
    entries: "Einträge",
  },
  newEntry: "Neuer Eintrag",
  allEntries: "Alle Einträge",
  active: "aktiv",
  views: {
    timeline: "Timeline",
    overview: "Übersicht",
    calendar: "Kalender",
    media: "Medien",
    map: "Karte",
  },
  viewAction: (label: string) => `Ansicht: ${label}`,
  themeAction: (label: string) => `Theme: ${label}`,
}

type SectionMessages = typeof de

const en: SectionMessages = {
  title: "Command palette",
  searchPlaceholder: "Search commands or entries…",
  noResults: "No results.",
  groups: {
    actions: "Actions",
    journals: "Journals",
    entries: "Entries",
  },
  newEntry: "New entry",
  allEntries: "All entries",
  active: "active",
  views: {
    timeline: "Timeline",
    overview: "Overview",
    calendar: "Calendar",
    media: "Media",
    map: "Map",
  },
  viewAction: (label: string) => `View: ${label}`,
  themeAction: (label: string) => `Theme: ${label}`,
}

const fr: SectionMessages = {
  title: "Palette de commandes",
  searchPlaceholder: "Rechercher des commandes ou des entrées…",
  noResults: "Aucun résultat.",
  groups: {
    actions: "Actions",
    journals: "Journaux",
    entries: "Entrées",
  },
  newEntry: "Nouvelle entrée",
  allEntries: "Toutes les entrées",
  active: "actif",
  views: {
    timeline: "Chronologie",
    overview: "Aperçu",
    calendar: "Calendrier",
    media: "Médias",
    map: "Carte",
  },
  viewAction: (label: string) => `Vue : ${label}`,
  themeAction: (label: string) => `Thème : ${label}`,
}

export const commandPaletteMessages = { de, en, fr }
