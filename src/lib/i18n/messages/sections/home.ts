// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  allEntries: "Alle Einträge",
  journalFallback: "Journal",
  newEntry: "Neuer Eintrag",
  newEntryShortcutTitle: "Neuer Eintrag (⌘N)",
  selectEntry: "Eintrag auswählen",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  allEntries: "All entries",
  journalFallback: "Journal",
  newEntry: "New entry",
  newEntryShortcutTitle: "New entry (⌘N)",
  selectEntry: "Select an entry",
}

const fr: SectionMessages = {
  allEntries: "Toutes les entrées",
  journalFallback: "Journal",
  newEntry: "Nouvelle entrée",
  newEntryShortcutTitle: "Nouvelle entrée (⌘N)",
  selectEntry: "Sélectionne une entrée",
}

export const homeMessages = { de, en, fr }
