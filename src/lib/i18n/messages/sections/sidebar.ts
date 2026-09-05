// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  navLabel: "Hauptnavigation",
  overview: "Übersicht",
  allEntries: "Alle Einträge",
  favourites: "Favoriten",
  media: "Medien",
  tags: "Tags",
  journals: "Journals",
  settings: "Einstellungen",
  signOut: "Abmelden",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  navLabel: "Main navigation",
  overview: "Overview",
  allEntries: "All entries",
  favourites: "Favourites",
  media: "Media",
  tags: "Tags",
  journals: "Journals",
  settings: "Settings",
  signOut: "Sign out",
}

const fr: SectionMessages = {
  navLabel: "Navigation principale",
  overview: "Aperçu",
  allEntries: "Toutes les entrées",
  favourites: "Favoris",
  media: "Médias",
  tags: "Tags",
  journals: "Journaux",
  settings: "Réglages",
  signOut: "Se déconnecter",
}

export const sidebarMessages = { de, en, fr }
