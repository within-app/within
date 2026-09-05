// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  toolbar: {
    tabs: {
      overview: "Übersicht",
      timeline: "Timeline",
      calendar: "Kalender",
      media: "Medien",
      map: "Karte",
    },
    mapOffline: "Karte offline nicht verfügbar",
    media: {
      all: "Alle",
      photo: "Fotos",
      audio: "Audio",
      video: "Video",
    },
    beforeLabel: (month: string, year: string) => `ab ${month} ${year}`,
    calendarClose: "Kalender schließen",
    calendarOpen: "Zu Monat springen",
    jumpDialogLabel: "Zeitsprung",
    loadError: "Fehler beim Laden",
    noEntries: "Keine Einträge",
    searchClose: "Suche schließen",
    searchOpen: "Suche öffnen",
    filterClose: "Filter schließen",
    filterOpen: "Filter öffnen",
    resetAll: "Alle Filter zurücksetzen",
    searchPlaceholder: "Einträge durchsuchen…",
    searchAriaLabel: "Einträge durchsuchen",
    starredOnly: "Nur markierte Einträge",
    pinnedOnly: "Offline verfügbar",
    tagsLabel: "Tags",
    mediaLabel: "Medien",
    resetFilters: "Filter zurücksetzen",
    monthFilterReset: "Monatsfilter zurücksetzen",
  },
  emptyState: {
    noResultsTitle: "Keine Treffer",
    noResultsSubtitle: "Kein Eintrag passt zu diesen Filtern.",
    resetFilters: "Filter zurücksetzen",
    noEntriesTitle: (journalName?: string) =>
      journalName ? `Noch kein Eintrag in „${journalName}"` : "Noch kein Eintrag vorhanden",
    noEntriesSubtitle: "Fang an und schreib deinen ersten Gedanken.",
    firstEntryCta: "Ersten Eintrag schreiben",
  },
  entryCard: {
    ariaLabel: (title: string, time: string) => `${title} — ${time}`,
    pending: "Ausstehend",
  },
  dayCard: {
    ariaLabel: (date: string, count: string) => `${date} — ${count}`,
    more: (n: number) => `+ ${n} weitere`,
  },
}

type SectionMessages = typeof de

const en: SectionMessages = {
  toolbar: {
    tabs: {
      overview: "Overview",
      timeline: "Timeline",
      calendar: "Calendar",
      media: "Media",
      map: "Map",
    },
    mapOffline: "Map unavailable offline",
    media: {
      all: "All",
      photo: "Photos",
      audio: "Audio",
      video: "Video",
    },
    beforeLabel: (month: string, year: string) => `from ${month} ${year}`,
    calendarClose: "Close calendar",
    calendarOpen: "Jump to month",
    jumpDialogLabel: "Time jump",
    loadError: "Error loading",
    noEntries: "No entries",
    searchClose: "Close search",
    searchOpen: "Open search",
    filterClose: "Close filters",
    filterOpen: "Open filters",
    resetAll: "Reset all filters",
    searchPlaceholder: "Search entries…",
    searchAriaLabel: "Search entries",
    starredOnly: "Favourites only",
    pinnedOnly: "Available offline",
    tagsLabel: "Tags",
    mediaLabel: "Media",
    resetFilters: "Reset filters",
    monthFilterReset: "Reset month filter",
  },
  emptyState: {
    noResultsTitle: "No results",
    noResultsSubtitle: "No entry matches these filters.",
    resetFilters: "Reset filters",
    noEntriesTitle: (journalName?: string) =>
      journalName ? `No entries yet in "${journalName}"` : "No entries yet",
    noEntriesSubtitle: "Get started and write your first thought.",
    firstEntryCta: "Write your first entry",
  },
  entryCard: {
    ariaLabel: (title: string, time: string) => `${title} — ${time}`,
    pending: "Pending",
  },
  dayCard: {
    ariaLabel: (date: string, count: string) => `${date} — ${count}`,
    more: (n: number) => `+ ${n} more`,
  },
}

const fr: SectionMessages = {
  toolbar: {
    tabs: {
      overview: "Aperçu",
      timeline: "Chronologie",
      calendar: "Calendrier",
      media: "Médias",
      map: "Carte",
    },
    mapOffline: "Carte indisponible hors ligne",
    media: {
      all: "Tous",
      photo: "Photos",
      audio: "Audio",
      video: "Vidéo",
    },
    beforeLabel: (month: string, year: string) => `à partir de ${month} ${year}`,
    calendarClose: "Fermer le calendrier",
    calendarOpen: "Aller à un mois",
    jumpDialogLabel: "Saut temporel",
    loadError: "Erreur de chargement",
    noEntries: "Aucune entrée",
    searchClose: "Fermer la recherche",
    searchOpen: "Ouvrir la recherche",
    filterClose: "Fermer les filtres",
    filterOpen: "Ouvrir les filtres",
    resetAll: "Réinitialiser tous les filtres",
    searchPlaceholder: "Rechercher des entrées…",
    searchAriaLabel: "Rechercher des entrées",
    starredOnly: "Favoris uniquement",
    pinnedOnly: "Disponible hors ligne",
    tagsLabel: "Tags",
    mediaLabel: "Médias",
    resetFilters: "Réinitialiser les filtres",
    monthFilterReset: "Réinitialiser le filtre du mois",
  },
  emptyState: {
    noResultsTitle: "Aucun résultat",
    noResultsSubtitle: "Aucune entrée ne correspond à ces filtres.",
    resetFilters: "Réinitialiser les filtres",
    noEntriesTitle: (journalName?: string) =>
      journalName ? `Aucune entrée pour l'instant dans « ${journalName} »` : "Aucune entrée pour l'instant",
    noEntriesSubtitle: "Commence et écris ta première pensée.",
    firstEntryCta: "Écris ta première entrée",
  },
  entryCard: {
    ariaLabel: (title: string, time: string) => `${title} — ${time}`,
    pending: "En attente",
  },
  dayCard: {
    ariaLabel: (date: string, count: string) => `${date} — ${count}`,
    more: (n: number) => `+ ${n} autres`,
  },
}

export const timelineMessages = { de, en, fr }
