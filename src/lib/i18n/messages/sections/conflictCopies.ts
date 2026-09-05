// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  title: (n: number) => (n === 1 ? "1 Konfliktkopie" : `${n} Konfliktkopien`),
  hint: "Beim Synchronisieren überschriebene Versionen dieses Eintrags. Zum Wiederherstellen Text kopieren und in den Eintrag übernehmen.",
  savedAt: (date: string) => `Gesichert am ${date}`,
}

type SectionMessages = typeof de

const en: SectionMessages = {
  title: (n: number) => (n === 1 ? "1 conflict copy" : `${n} conflict copies`),
  hint: "Versions of this entry that were overwritten during sync. To restore, copy the text back into the entry.",
  savedAt: (date: string) => `Saved on ${date}`,
}

const fr: SectionMessages = {
  title: (n: number) => (n === 1 ? "1 copie de conflit" : `${n} copies de conflit`),
  hint: "Versions de cette entrée écrasées lors de la synchronisation. Pour restaurer, copiez le texte dans l'entrée.",
  savedAt: (date: string) => `Sauvegardée le ${date}`,
}

export const conflictCopiesMessages = { de, en, fr }
