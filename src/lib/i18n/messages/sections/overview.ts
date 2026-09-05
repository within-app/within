// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  streak: "Serie",
  streakSubtitle: "Tage in Folge",
  entries: "Einträge",
  media: "Medien",
  days: "Tage",
  countries: "Länder",
  onThisDay: "An diesem Tag",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  streak: "Streak",
  streakSubtitle: "Day streak",
  entries: "Entries",
  media: "Media",
  days: "Days",
  countries: "Countries",
  onThisDay: "On this day",
}

const fr: SectionMessages = {
  streak: "Série",
  streakSubtitle: "Jours consécutifs",
  entries: "Entrées",
  media: "Médias",
  days: "Jours",
  countries: "Pays",
  onThisDay: "Ce jour-là",
}

export const overviewMessages = { de, en, fr }
