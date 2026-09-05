import type { Messages } from "./de"
import { timelineMessages } from "./sections/timeline"
import { homeMessages } from "./sections/home"
import { mapMessages } from "./sections/map"
import { editorMessages } from "./sections/editor"
import { calendarMessages } from "./sections/calendar"
import { overviewMessages } from "./sections/overview"
import { mediaMessages } from "./sections/media"
import { onThisDayMessages } from "./sections/onThisDay"
import { detailMessages } from "./sections/detail"
import { themeMessages } from "./sections/theme"
import { commandPaletteMessages } from "./sections/commandPalette"
import { sidebarMessages } from "./sections/sidebar"
import { loginMessages } from "./sections/login"
import { lockMessages } from "./sections/lock"
import { swUpdateMessages } from "./sections/swUpdate"
import { conflictCopiesMessages } from "./sections/conflictCopies"
import { shareMessages } from "./sections/share"
import { syncMessages } from "./sections/sync"
import { errorsMessages } from "./sections/errors"

/** Français — tutoiement, cohérent avec le ton de l'app (journal privé). */
export const fr: Messages = {
  date: {
    today: "Aujourd'hui",
    yesterday: "Hier",
    long: "EEEE d MMMM yyyy",
    dayMonthLong: "d MMMM",
    dayMonthShort: "d MMM",
    dayMonthYear: "d MMMM yyyy",
    monthYear: "MMMM yyyy",
    numeric: "dd/MM/yyyy",
    numericShort: "d/M/yyyy",
  },
  common: {
    back: "Retour",
    cancel: "Annuler",
    loading: "Chargement…",
    untitled: "Sans titre",
    unknownError: "Erreur inconnue",
    networkError: "Erreur réseau",
    entryCount: (n: number) => (n === 1 ? "1 entrée" : `${n} entrées`),
  },
  settings: {
    title: "Réglages",
    subtitle: "Langue, import, export & journaux",
    backToOverview: "Retour à l'aperçu",
    language: {
      title: "Langue",
      description: "Langue de l'interface. Le choix est enregistré et s'applique à tous tes appareils.",
    },
    uploads: {
      title: "Uploads",
      description: "S'applique uniquement à cet appareil.",
      downscaleLabel: "Réduire les grandes photos avant l'envoi",
      downscaleHint:
        "Pour les appareils avec peu de mémoire : les photos de plus de 6 Mo sont réduites à 4096 px max. (JPEG). Laisse ce réglage désactivé sur ton ordinateur pour envoyer les originaux en pleine qualité.",
    },
    offlinePreviews: {
      title: "Aperçus hors ligne",
      description:
        "Les aperçus photo de cette période sont disponibles hors ligne dans l'aperçu médias (stockés chiffrés). Les photos en pleine résolution restent hors ligne uniquement pour les entrées épinglées. S'applique uniquement à cet appareil.",
      periodLabel: "Période",
      periodOff: "Désactivé",
      period1m: "1 mois",
      period3m: "3 mois",
      period6m: "6 mois",
      period1y: "1 an",
      period2y: "2 ans",
      periodAll: "Tout",
      storageInfo: (count: number, size: string) =>
        count === 1 ? `1 aperçu · ${size}` : `${count} aperçus · ${size}`,
      storageHint:
        "Chiffres du serveur pour cette période — téléchargés lors de la prochaine synchronisation en ligne, pas immédiatement.",
      storageOff: "Aucun aperçu hors ligne. Les entrées épinglées restent entièrement disponibles.",
      storageUnavailable: "Estimation du stockage actuellement indisponible.",
      loading: "Estimation du stockage…",
    },
    security: {
      title: "Sécurité",
      description: "Verrouillage de l'app et chiffrement des données hors ligne. S'applique uniquement à cet appareil.",
      autoLockLabel: "Verrouiller automatiquement après",
      autoLockMinutes: (n: number) => (n === 1 ? "1 minute" : `${n} minutes`),
      lockNow: "Verrouiller maintenant",
      changePinTitle: "Changer le code de l'app",
      currentPin: "Code actuel",
      newPin: "Nouveau code",
      confirmNewPin: "Répéter le nouveau code",
      changePin: "Changer le code",
      changing: "Modification…",
      pinChanged: "Code modifié.",
      wrongCurrentPin: "Le code actuel est incorrect.",
    },
    backup: {
      title: "Sauvegarde",
      description: "État de la sauvegarde nocturne du serveur (base de données + médias).",
      lastRun: (d: string) => `Dernière exécution : ${d}`,
      statusOk: "La sauvegarde est à jour.",
      statusStale: (h: number) => `La dernière exécution réussie date de plus de ${h} heures — la sauvegarde nocturne ne tourne plus.`,
      statusError: "La dernière sauvegarde a échoué.",
      statusNone: "Aucune sauvegarde n'a encore été effectuée. Configuration : docs/backup-restore.md.",
      statusUnavailable: "État de la sauvegarde indisponible.",
      verifiedCounts: (e: number, m: number) => `Vérification de restauration : ${e} entrées · ${m} médias`,
    },
    import: {
      title: "Importer",
      description:
        "Exporte ton journal DayOne au format ZIP (JSON + photos) et téléverse-le ici. Les entrées déjà présentes sont automatiquement ignorées.",
      targetJournal: "Journal cible",
      autoOption: "— Automatique (import DayOne)",
      journalNameLabel: "Nom du nouveau journal",
      journalNamePlaceholder: "DayOne Import",
      chooseZip: "Choisir un fichier ZIP",
      start: "Lancer l'import",
      running: "Import en cours…",
      doneIn: (seconds: string) => `Import terminé en ${seconds} s`,
      resultLine: (imported: number, skipped: number) => `${imported} importées · ${skipped} ignorées`,
      errorCount: (n: number) => (n === 1 ? "1 erreur" : `${n} erreurs`),
      warningCount: (n: number) => (n === 1 ? "1 avertissement (p. ex. fichier absent du ZIP)" : `${n} avertissements (p. ex. fichier absent du ZIP)`),
      networkError: "Erreur réseau pendant l'import",
    },
    export: {
      title: "Exporter",
      description: "Exporte tes entrées dans une archive ZIP (JSON + toutes les photos) au format propre à l'app.",
      all: "Tout exporter",
    },
    journals: {
      title: "Journaux",
      description: "Gérer les journaux : créer, modifier et supprimer.",
      empty: "Aucun journal pour l'instant.",
      entryCount: (n: number) => (n === 1 ? "1 entrée" : `${n} entrées`),
      delete: "Supprimer",
      createHeading: "Créer un nouveau journal",
      nameLabel: "Nom",
      namePlaceholder: "Nom du journal",
      colorLabel: "Couleur",
      create: "Créer",
      createFailed: "Le journal n'a pas pu être créé",
      editAria: (name: string) => `Modifier le journal « ${name} »`,
      editTitle: "Modifier le journal",
      save: "Enregistrer",
      saving: "Enregistrement…",
      editFailed: "Le journal n'a pas pu être enregistré",
      deleteConfirmTitle: (name: string) => `Supprimer le journal « ${name} » ?`,
      deleteConfirmDescription: (n: number) =>
        `Les ${n} entrées, photos et pièces jointes seront supprimées définitivement. Cette action est irréversible.`,
      deleting: "Suppression…",
      deleteFinal: "Supprimer définitivement",
    },
  },
  timeline: timelineMessages.fr,
  home: homeMessages.fr,
  map: mapMessages.fr,
  editor: editorMessages.fr,
  calendar: calendarMessages.fr,
  overview: overviewMessages.fr,
  media: mediaMessages.fr,
  onThisDay: onThisDayMessages.fr,
  detail: detailMessages.fr,
  theme: themeMessages.fr,
  commandPalette: commandPaletteMessages.fr,
  sidebar: sidebarMessages.fr,
  login: loginMessages.fr,
  lock: lockMessages.fr,
  swUpdate: swUpdateMessages.fr,
  conflictCopies: conflictCopiesMessages.fr,
  share: shareMessages.fr,
  sync: syncMessages.fr,
  errors: errorsMessages.fr,
}
