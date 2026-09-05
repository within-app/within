// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
// Deckt sync-badge.tsx und ConflictPanel.tsx ab.
const de = {
  badge: {
    errorAria: "Synchronisierungsfehler — zum Wiederholen tippen",
    offlineAria: "Offline",
    syncingAria: "Synchronisiere…",
    conflictsAria: (n: number) => `${n} Konflikte – anzeigen`,
    pendingAria: (n: number) => `${n} ausstehende Änderungen — zum Synchronisieren tippen`,
    syncedAria: "Synchronisiert",
  },
  conflicts: {
    title: (n: number) => (n === 1 ? "1 Konflikt" : `${n} Konflikte`),
    description:
      "Diese Versionen wurden durch einen neueren Eintrag überschrieben. Du kannst sie wiederherstellen oder verwerfen.",
    noContent: "Kein Inhalt",
    restore: "Wiederherstellen",
    dismiss: "Verwerfen",
  },
}

type SectionMessages = typeof de

const en: SectionMessages = {
  badge: {
    errorAria: "Sync error — tap to retry",
    offlineAria: "Offline",
    syncingAria: "Syncing",
    conflictsAria: (n: number) => `${n} conflicts – view`,
    pendingAria: (n: number) => `${n} pending changes — tap to sync`,
    syncedAria: "Synced",
  },
  conflicts: {
    title: (n: number) => (n === 1 ? "1 conflict" : `${n} conflicts`),
    description:
      "These versions were overwritten by a newer entry. You can restore or discard them.",
    noContent: "No content",
    restore: "Restore",
    dismiss: "Discard",
  },
}

const fr: SectionMessages = {
  badge: {
    errorAria: "Erreur de synchronisation — appuie pour réessayer",
    offlineAria: "Hors ligne",
    syncingAria: "Synchronisation",
    conflictsAria: (n: number) => `${n} conflits – afficher`,
    pendingAria: (n: number) => `${n} modifications en attente — appuie pour synchroniser`,
    syncedAria: "Synchronisé",
  },
  conflicts: {
    title: (n: number) => (n === 1 ? "1 conflit" : `${n} conflits`),
    description:
      "Ces versions ont été écrasées par une entrée plus récente. Tu peux les restaurer ou les ignorer.",
    noContent: "Aucun contenu",
    restore: "Restaurer",
    dismiss: "Ignorer",
  },
}

export const syncMessages = { de, en, fr }
