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

/**
 * Kanonisches UI-Wörterbuch — Deutsch ist die Quelle der Wahrheit.
 * en.ts/fr.ts sind als `Messages` typisiert: fehlende oder überzählige Keys
 * sind Compile-Fehler. Parametrisierte Texte sind einfache Funktionen —
 * bewusst kein ICU-Parser (intentionally minimal: 3 Sprachen, Single-User).
 * Screen-Sections liegen modular unter ./sections/ (ein Bereich pro Datei).
 */
export const de = {
  date: {
    today: "Heute",
    yesterday: "Gestern",
    /** date-fns-Muster — pro Sprache eigene Reihenfolge/Interpunktion */
    long: "EEEE, d. MMMM yyyy",
    dayMonthLong: "d. MMMM",
    dayMonthShort: "d. MMM",
    dayMonthYear: "d. MMMM yyyy",
    monthYear: "MMMM yyyy",
    numeric: "dd.MM.yyyy",
    numericShort: "d.M.yyyy",
  },
  common: {
    back: "Zurück",
    cancel: "Abbrechen",
    loading: "Lade…",
    untitled: "Ohne Titel",
    unknownError: "Unbekannter Fehler",
    networkError: "Netzwerkfehler",
    entryCount: (n: number) => (n === 1 ? "1 Eintrag" : `${n} Einträge`),
  },
  settings: {
    title: "Einstellungen",
    subtitle: "Sprache, Import, Export & Journals",
    backToOverview: "Zurück zur Übersicht",
    language: {
      title: "Sprache",
      description: "Sprache der Benutzeroberfläche. Die Wahl wird gespeichert und gilt auf allen Geräten.",
    },
    uploads: {
      title: "Uploads",
      description: "Gilt nur für dieses Gerät.",
      downscaleLabel: "Große Fotos vor dem Upload verkleinern",
      downscaleHint:
        "Für Geräte mit wenig Speicher: Fotos über 6 MB werden auf max. 4096 px verkleinert (JPEG). Auf dem Desktop ausgeschaltet lassen, um Originale in voller Qualität hochzuladen.",
    },
    offlinePreviews: {
      title: "Offline-Vorschauen",
      description:
        "Foto-Vorschauen dieses Zeitraums sind offline in der Medienübersicht verfügbar (verschlüsselt gespeichert). Vollauflösungen bleiben nur für gepinnte Einträge offline. Gilt nur für dieses Gerät.",
      periodLabel: "Zeitraum",
      periodOff: "Aus",
      period1m: "1 Monat",
      period3m: "3 Monate",
      period6m: "6 Monate",
      period1y: "1 Jahr",
      period2y: "2 Jahre",
      periodAll: "Alles",
      storageInfo: (count: number, size: string) =>
        count === 1 ? `1 Vorschau · ${size}` : `${count} Vorschauen · ${size}`,
      storageHint:
        "Laut Server für diesen Zeitraum — geladen wird beim nächsten Online-Abgleich, nicht sofort.",
      storageOff: "Keine Vorschauen offline. Gepinnte Einträge bleiben vollständig verfügbar.",
      storageUnavailable: "Speicherbedarf derzeit nicht abrufbar.",
      loading: "Ermittle Speicherbedarf…",
    },
    security: {
      title: "Sicherheit",
      description: "App-Sperre und Verschlüsselung der Offline-Daten. Gilt nur für dieses Gerät.",
      autoLockLabel: "Automatisch sperren nach",
      autoLockMinutes: (n: number) => (n === 1 ? "1 Minute" : `${n} Minuten`),
      lockNow: "Jetzt sperren",
      changePinTitle: "App-PIN ändern",
      currentPin: "Aktuelle PIN",
      newPin: "Neue PIN",
      confirmNewPin: "Neue PIN wiederholen",
      changePin: "PIN ändern",
      changing: "Ändere…",
      pinChanged: "PIN geändert.",
      wrongCurrentPin: "Aktuelle PIN ist falsch.",
    },
    backup: {
      title: "Backup",
      description: "Status der nächtlichen Server-Sicherung (Datenbank + Medien).",
      lastRun: (d: string) => `Letzter Lauf: ${d}`,
      statusOk: "Backup ist aktuell.",
      statusStale: (h: number) => `Letzter erfolgreicher Lauf ist älter als ${h} Stunden — die nächtliche Sicherung läuft nicht mehr.`,
      statusError: "Letzter Backup-Lauf ist fehlgeschlagen.",
      statusNone: "Noch kein Backup gelaufen. Einrichtung: docs/backup-restore.md.",
      statusUnavailable: "Backup-Status nicht abrufbar.",
      verifiedCounts: (e: number, m: number) => `Restore-Probe geprüft: ${e} Einträge · ${m} Medien`,
    },
    import: {
      title: "Importieren",
      description:
        "Exportiere dein DayOne-Tagebuch als ZIP (JSON + Fotos) und lade es hier hoch. Bereits vorhandene Einträge werden automatisch übersprungen.",
      targetJournal: "Ziel-Journal",
      autoOption: "— Automatisch (DayOne Import)",
      journalNameLabel: "Name des neuen Journals",
      journalNamePlaceholder: "DayOne Import",
      chooseZip: "ZIP-Datei auswählen",
      start: "Import starten",
      running: "Importiere…",
      doneIn: (seconds: string) => `Import abgeschlossen in ${seconds} s`,
      resultLine: (imported: number, skipped: number) => `${imported} importiert · ${skipped} übersprungen`,
      errorCount: (n: number) => (n === 1 ? "1 Fehler" : `${n} Fehler`),
      warningCount: (n: number) => (n === 1 ? "1 Hinweis (z. B. Datei fehlt im ZIP)" : `${n} Hinweise (z. B. Datei fehlt im ZIP)`),
      networkError: "Netzwerkfehler beim Import",
    },
    export: {
      title: "Exportieren",
      description: "Exportiere deine Einträge als ZIP-Datei (JSON + alle Fotos) im eigenen Format.",
      all: "Alle exportieren",
    },
    journals: {
      title: "Journals",
      description: "Journals verwalten: anlegen, bearbeiten und löschen.",
      empty: "Noch keine Journals vorhanden.",
      entryCount: (n: number) => (n === 1 ? "1 Eintrag" : `${n} Einträge`),
      delete: "Löschen",
      createHeading: "Neues Journal anlegen",
      nameLabel: "Name",
      namePlaceholder: "Name des Journals",
      colorLabel: "Farbe",
      create: "Erstellen",
      createFailed: "Journal konnte nicht erstellt werden",
      editAria: (name: string) => `Journal „${name}“ bearbeiten`,
      editTitle: "Journal bearbeiten",
      save: "Speichern",
      saving: "Speichere…",
      editFailed: "Journal konnte nicht gespeichert werden",
      deleteConfirmTitle: (name: string) => `Journal „${name}" löschen?`,
      deleteConfirmDescription: (n: number) =>
        `Alle ${n} Einträge, Fotos und Anhänge werden unwiderruflich gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.`,
      deleting: "Lösche…",
      deleteFinal: "Endgültig löschen",
    },
  },
  timeline: timelineMessages.de,
  home: homeMessages.de,
  map: mapMessages.de,
  editor: editorMessages.de,
  calendar: calendarMessages.de,
  overview: overviewMessages.de,
  media: mediaMessages.de,
  onThisDay: onThisDayMessages.de,
  detail: detailMessages.de,
  theme: themeMessages.de,
  commandPalette: commandPaletteMessages.de,
  sidebar: sidebarMessages.de,
  login: loginMessages.de,
  lock: lockMessages.de,
  swUpdate: swUpdateMessages.de,
  conflictCopies: conflictCopiesMessages.de,
  share: shareMessages.de,
  sync: syncMessages.de,
  errors: errorsMessages.de,
}

export type Messages = typeof de
