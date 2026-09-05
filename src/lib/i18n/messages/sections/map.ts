// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  noLocationsTitle: "Noch keine Standortdaten",
  noLocationsSubtitle: "Füge einem Eintrag einen Standort hinzu oder importiere DayOne-Einträge mit GPS-Daten.",
  locationCount: (n: number) => (n === 1 ? "1 Standort" : `${n} Standorte`),
}

type SectionMessages = typeof de

const en: SectionMessages = {
  noLocationsTitle: "No location data yet",
  noLocationsSubtitle: "Add a location to an entry or import DayOne entries with GPS data.",
  locationCount: (n: number) => (n === 1 ? "1 location" : `${n} locations`),
}

const fr: SectionMessages = {
  noLocationsTitle: "Pas encore de données de localisation",
  noLocationsSubtitle: "Ajoute un lieu à une entrée ou importe des entrées DayOne avec des données GPS.",
  locationCount: (n: number) => (n === 1 ? "1 lieu" : `${n} lieux`),
}

export const mapMessages = { de, en, fr }
