// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
// Umfasst entry-detail.tsx, photo-gallery.tsx, audio-player.tsx, video-player.tsx.
const de = {
  offlinePin: {
    saving: "Wird gespeichert…",
    unpin: "Offline-Speicherung aufheben",
    pin: "Für offline speichern",
  },
  favourite: {
    remove: "Favorit entfernen",
    add: "Als Favorit markieren",
  },
  edit: "Eintrag bearbeiten",
  delete: "Eintrag löschen",
  notFound: {
    title: "Eintrag nicht gefunden",
    description: "Der Eintrag existiert nicht mehr oder konnte nicht geladen werden.",
  },
  gallery: {
    photoOpen: (n: number, total: number) => `Foto ${n} von ${total} öffnen`,
    photoOpenPending: (n: number, total: number) => `Foto ${n} von ${total} öffnen — wartet auf Upload`,
    photoOf: (n: number, total: number) => `Foto ${n} von ${total}`,
    photoFallback: "Foto",
    uploadFailed: "Upload fehlgeschlagen",
    uploadFailedTitle: "Upload fehlgeschlagen — Datei bleibt nur auf diesem Gerät",
    pending: "Wartet",
    pendingTitle: "Wird beim nächsten Online-Gang hochgeladen",
    close: "Schließen",
    previousImage: "Vorheriges Bild",
    nextImage: "Nächstes Bild",
  },
  audio: {
    unavailable: "Audio nicht verfügbar",
    play: "Abspielen",
    pause: "Pause",
    position: "Audiowiedergabe-Position",
  },
  video: {
    unavailable: "Video nicht verfügbar",
  },
}

type SectionMessages = typeof de

const en: SectionMessages = {
  offlinePin: {
    saving: "Saving…",
    unpin: "Remove offline storage",
    pin: "Save for offline",
  },
  favourite: {
    remove: "Remove favourite",
    add: "Mark as favourite",
  },
  edit: "Edit entry",
  delete: "Delete entry",
  notFound: {
    title: "Entry not found",
    description: "The entry no longer exists or could not be loaded.",
  },
  gallery: {
    photoOpen: (n: number, total: number) => `Open photo ${n} of ${total}`,
    photoOpenPending: (n: number, total: number) => `Open photo ${n} of ${total} — upload pending`,
    photoOf: (n: number, total: number) => `Photo ${n} of ${total}`,
    photoFallback: "Photo",
    uploadFailed: "Upload failed",
    uploadFailedTitle: "Upload failed — file stays on this device only",
    pending: "Pending",
    pendingTitle: "Will upload the next time you're online",
    close: "Close",
    previousImage: "Previous image",
    nextImage: "Next image",
  },
  audio: {
    unavailable: "Audio unavailable",
    play: "Play",
    pause: "Pause",
    position: "Audio playback position",
  },
  video: {
    unavailable: "Video unavailable",
  },
}

const fr: SectionMessages = {
  offlinePin: {
    saving: "Enregistrement…",
    unpin: "Annuler l'enregistrement hors ligne",
    pin: "Enregistrer hors ligne",
  },
  favourite: {
    remove: "Retirer des favoris",
    add: "Ajouter aux favoris",
  },
  edit: "Modifier l'entrée",
  delete: "Supprimer l'entrée",
  notFound: {
    title: "Entrée introuvable",
    description: "Cette entrée n'existe plus ou n'a pas pu être chargée.",
  },
  gallery: {
    photoOpen: (n: number, total: number) => `Ouvrir la photo ${n} sur ${total}`,
    photoOpenPending: (n: number, total: number) => `Ouvrir la photo ${n} sur ${total} — en attente d'envoi`,
    photoOf: (n: number, total: number) => `Photo ${n} sur ${total}`,
    photoFallback: "Photo",
    uploadFailed: "Échec de l'envoi",
    uploadFailedTitle: "Échec de l'envoi — le fichier reste uniquement sur cet appareil",
    pending: "En attente",
    pendingTitle: "Sera envoyé à la prochaine connexion",
    close: "Fermer",
    previousImage: "Image précédente",
    nextImage: "Image suivante",
  },
  audio: {
    unavailable: "Audio indisponible",
    play: "Lecture",
    pause: "Pause",
    position: "Position de lecture audio",
  },
  video: {
    unavailable: "Vidéo indisponible",
  },
}

export const detailMessages = { de, en, fr }
