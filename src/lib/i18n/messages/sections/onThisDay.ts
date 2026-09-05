// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  title: "An diesem Tag",
  previousDay: "Vorheriger Tag",
  nextDay: "Nächster Tag",
  offlineNotice: "Offline — lokal gespeicherte Einträge; Medien nur soweit offline verfügbar.",
  noDataTitle: "Keine Daten verfügbar",
  noDataDescription: "Keine Verbindung zum Server und keine lokal gespeicherten Einträge.",
  noEntriesOn: (day: string) => `Keine Einträge am ${day}`,
  loadedCap: (loaded: number, total: number) => `Nur die neuesten ${loaded} von ${total} Einträgen geladen.`,
  open: "Öffnen",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  title: "On this day",
  previousDay: "Previous day",
  nextDay: "Next day",
  offlineNotice: "Offline — locally stored entries; media only where available offline.",
  noDataTitle: "No data available",
  noDataDescription: "No connection to the server and no locally stored entries.",
  noEntriesOn: (day: string) => `No entries on ${day}`,
  loadedCap: (loaded: number, total: number) => `Only the latest ${loaded} of ${total} entries loaded.`,
  open: "Open",
}

const fr: SectionMessages = {
  title: "Ce jour-là",
  previousDay: "Jour précédent",
  nextDay: "Jour suivant",
  offlineNotice: "Hors ligne — entrées enregistrées localement ; médias disponibles seulement s'ils le sont hors ligne.",
  noDataTitle: "Aucune donnée disponible",
  noDataDescription: "Aucune connexion au serveur et aucune entrée enregistrée localement.",
  noEntriesOn: (day: string) => `Aucune entrée le ${day}`,
  loadedCap: (loaded: number, total: number) => `Seules les ${loaded} entrées les plus récentes sur ${total} sont chargées.`,
  open: "Ouvrir",
}

export const onThisDayMessages = { de, en, fr }
