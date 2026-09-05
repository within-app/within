// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  preparing: "Inhalt wird vorbereitet…",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  preparing: "Preparing content…",
}

const fr: SectionMessages = {
  preparing: "Préparation du contenu…",
}

export const shareMessages = { de, en, fr }
