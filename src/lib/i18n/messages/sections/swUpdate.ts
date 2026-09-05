// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  available: "Neue Version verfügbar.",
  reload: "Jetzt aktualisieren",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  available: "New version available.",
  reload: "Update now",
}

const fr: SectionMessages = {
  available: "Nouvelle version disponible.",
  reload: "Mettre à jour",
}

export const swUpdateMessages = { de, en, fr }
