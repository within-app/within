// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  jumpToToday: "Zum heutigen Tag springen",
  loadEarlierMonths: "Frühere Monate",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  jumpToToday: "Jump to today",
  loadEarlierMonths: "Earlier months",
}

const fr: SectionMessages = {
  jumpToToday: "Aller à aujourd'hui",
  loadEarlierMonths: "Mois précédents",
}

export const calendarMessages = { de, en, fr }
