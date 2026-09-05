// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  offlineTitle: "Fotos offline nicht verfügbar",
  offlineDescription: "Verbinde dich, um deine Fotos zu sehen.",
  emptyTitle: "Noch keine Medien vorhanden",
  emptyDescription: "Erstelle einen Eintrag mit Fotos, Videos oder Audio, um sie hier zu sehen.",
  photoAlt: (date: string) => `Foto vom ${date}`,
  videoAlt: (date: string) => `Video vom ${date}`,
  audioAlt: (date: string) => `Audio vom ${date}`,
}

type SectionMessages = typeof de

const en: SectionMessages = {
  offlineTitle: "Photos unavailable offline",
  offlineDescription: "Connect to see your photos.",
  emptyTitle: "No media yet",
  emptyDescription: "Create an entry with photos, videos or audio to see it here.",
  photoAlt: (date: string) => `Photo from ${date}`,
  videoAlt: (date: string) => `Video from ${date}`,
  audioAlt: (date: string) => `Audio from ${date}`,
}

const fr: SectionMessages = {
  offlineTitle: "Photos indisponibles hors ligne",
  offlineDescription: "Connecte-toi pour voir tes photos.",
  emptyTitle: "Aucun média pour l'instant",
  emptyDescription: "Crée une entrée avec des photos, vidéos ou fichiers audio pour les voir ici.",
  photoAlt: (date: string) => `Photo du ${date}`,
  videoAlt: (date: string) => `Vidéo du ${date}`,
  audioAlt: (date: string) => `Audio du ${date}`,
}

export const mediaMessages = { de, en, fr }
