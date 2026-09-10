// Section dictionary — Error-Boundary (error.tsx / global-error.tsx). Wird ohne
// React-Context gelesen: der LocaleProvider kann selbst im gefallenen Baum liegen.
const de = {
  title: "Da ist etwas schiefgelaufen.",
  body: "Die Seite konnte nicht geladen werden — meist hilft Neuladen, zum Beispiel nach einem Update.",
  reload: "Neu laden",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  title: "Something went wrong.",
  body: "The page could not be loaded — reloading usually fixes it, for example after an update.",
  reload: "Reload",
}

const fr: SectionMessages = {
  title: "Une erreur s'est produite.",
  body: "La page n'a pas pu être chargée — recharger suffit généralement, par exemple après une mise à jour.",
  reload: "Recharger",
}

export const errorPageMessages = { de, en, fr }
