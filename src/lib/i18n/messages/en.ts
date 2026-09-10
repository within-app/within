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
import { errorPageMessages } from "./sections/errorPage"

/** English (en-GB spelling and date order). */
export const en: Messages = {
  date: {
    today: "Today",
    yesterday: "Yesterday",
    long: "EEEE, d MMMM yyyy",
    dayMonthLong: "d MMMM",
    dayMonthShort: "d MMM",
    dayMonthYear: "d MMMM yyyy",
    monthYear: "MMMM yyyy",
    numeric: "dd/MM/yyyy",
    numericShort: "d/M/yyyy",
  },
  common: {
    back: "Back",
    cancel: "Cancel",
    loading: "Loading…",
    untitled: "Untitled",
    unknownError: "Unknown error",
    networkError: "Network error",
    entryCount: (n: number) => (n === 1 ? "1 entry" : `${n} entries`),
  },
  settings: {
    title: "Settings",
    subtitle: "Language, import, export & journals",
    backToOverview: "Back to overview",
    language: {
      title: "Language",
      description: "Interface language. Your choice is saved and applies to all your devices.",
    },
    uploads: {
      title: "Uploads",
      description: "Applies to this device only.",
      downscaleLabel: "Shrink large photos before uploading",
      downscaleHint:
        "For devices with little memory: photos over 6 MB are resized to max. 4096 px (JPEG). Leave this off on your desktop to upload full-quality originals.",
    },
    offlinePreviews: {
      title: "Offline previews",
      description:
        "Photo previews from this period are available offline in the media overview (stored encrypted). Full-resolution photos stay offline for pinned entries only. Applies to this device only.",
      periodLabel: "Period",
      periodOff: "Off",
      period1m: "1 month",
      period3m: "3 months",
      period6m: "6 months",
      period1y: "1 year",
      period2y: "2 years",
      periodAll: "Everything",
      storageInfo: (count: number, size: string) =>
        count === 1 ? `1 preview · ${size}` : `${count} previews · ${size}`,
      storageHint:
        "Server numbers for this period — downloaded on the next online refresh, not instantly.",
      storageOff: "No previews offline. Pinned entries stay fully available.",
      storageUnavailable: "Storage estimate currently unavailable.",
      loading: "Estimating storage…",
    },
    security: {
      title: "Security",
      description: "App lock and offline data encryption. Applies to this device only.",
      autoLockLabel: "Lock automatically after",
      autoLockMinutes: (n: number) => (n === 1 ? "1 minute" : `${n} minutes`),
      lockNow: "Lock now",
      changePinTitle: "Change app PIN",
      currentPin: "Current PIN",
      newPin: "New PIN",
      confirmNewPin: "Repeat new PIN",
      changePin: "Change PIN",
      changing: "Changing…",
      pinChanged: "PIN changed.",
      wrongCurrentPin: "Current PIN is wrong.",
    },
    backup: {
      title: "Backup",
      description: "Status of the nightly server backup (database + media).",
      lastRun: (d: string) => `Last run: ${d}`,
      statusOk: "Backup is up to date.",
      statusStale: (h: number) => `Last successful run is older than ${h} hours — the nightly backup is no longer running.`,
      statusError: "The last backup run failed.",
      statusNone: "No backup has run yet. Setup: docs/backup-restore.md.",
      statusUnavailable: "Backup status unavailable.",
      verifiedCounts: (e: number, m: number) => `Restore check verified: ${e} entries · ${m} media`,
      nightlyToggle: "Nightly backup",
      pausedSince: (d: string) => `Backup paused since ${d}`,
      toggleFailed: "Could not switch — please try again.",
      destUsage: (used: string, total: string, pct: number) => `Backup drive: ${used} of ${total} used (${pct} %)`,
      destWarn: "The backup drive is getting full.",
      destCritical: "The backup drive is almost full.",
      restore: {
        title: "Restore",
        description: "Load an existing backup into this installation — for when the app was set up from scratch.",
        notMounted: "Backup folder not mounted — see x-backup-dir in docker-compose.yml.",
        noDumps: "No backup found.",
        counts: (e: number, m: number) => `${e} entries · ${m} media`,
        countsUnknown: "Count unknown (backup taken before this update)",
        mediaNote: "Photos and videos are always restored to the state of the most recent backup, regardless of which database backup you pick.",
        otherDevicesNote: "Afterwards, lock other devices once and choose \"Forgot PIN?\" on the lock screen to reset their local data — only then do they fully load the restored state.",
        button: "Restore backup",
        confirmTitle: "Restore this backup?",
        confirmEmpty: (d: string, e: number, m: number) => `Restore the backup from ${d} with ${e} entries and ${m} media? This installation is empty, nothing is lost.`,
        confirmEmptyUnknown: (d: string) => `Restore the backup from ${d}? This installation is empty, nothing is lost.`,
        confirmOverwrite: (e: number, m: number) => `Warning: ${e} entries and ${m} media in this installation will be irreversibly replaced by the backup.`,
        passwordLabel: "Password",
        typeWordLabel: (w: string) => `Type ${w} to confirm`,
        confirmAction: "Restore now",
        wrongPassword: "Wrong password.",
        runningTitle: "Restoring…",
        runningText: "Database and media are being restored from the backup. This usually takes less than a minute. Please leave this page open.",
        doneText: (d: string, e: number | null, m: number | null) =>
          e === null || m === null ? `Done — state as of ${d}.` : `Done — state as of ${d}: ${e} entries · ${m} media.`,
        reloadButton: "Reload app",
        failedText: "Restore failed.",
        failedTimeout: "The backup service did not pick up the request. Is the backup container running? Details: docs/backup-restore.md.",
        lastRestore: (d: string, f: string) => `Last restore: ${d} from ${f}`,
        lastRestoreFailed: "The last restore failed.",
        close: "Close",
      },
    },
    import: {
      title: "Import",
      description:
        "Export your DayOne journal as a ZIP (JSON + photos) and upload it here. Entries that already exist are skipped automatically.",
      targetJournal: "Target journal",
      autoOption: "— Automatic (DayOne import)",
      journalNameLabel: "Name of the new journal",
      journalNamePlaceholder: "DayOne Import",
      chooseZip: "Choose ZIP file",
      start: "Start import",
      running: "Importing…",
      doneIn: (seconds: string) => `Import finished in ${seconds} s`,
      resultLine: (imported: number, skipped: number) => `${imported} imported · ${skipped} skipped`,
      errorCount: (n: number) => (n === 1 ? "1 error" : `${n} errors`),
      warningCount: (n: number) => (n === 1 ? "1 warning (e.g. file missing from ZIP)" : `${n} warnings (e.g. file missing from ZIP)`),
      networkError: "Network error during import",
    },
    export: {
      title: "Export",
      description: "Export your entries as a ZIP file (JSON + all photos) in the app's own format.",
      all: "Export all",
    },
    journals: {
      title: "Journals",
      description: "Manage journals: create, edit and delete.",
      empty: "No journals yet.",
      entryCount: (n: number) => (n === 1 ? "1 entry" : `${n} entries`),
      delete: "Delete",
      createHeading: "Create a new journal",
      nameLabel: "Name",
      namePlaceholder: "Journal name",
      colorLabel: "Colour",
      create: "Create",
      createFailed: "Journal could not be created",
      editAria: (name: string) => `Edit journal “${name}”`,
      editTitle: "Edit journal",
      save: "Save",
      saving: "Saving…",
      editFailed: "Journal could not be saved",
      deleteConfirmTitle: (name: string) => `Delete journal "${name}"?`,
      deleteConfirmDescription: (n: number) =>
        `All ${n} entries, photos and attachments will be deleted permanently. This action cannot be undone.`,
      deleting: "Deleting…",
      deleteFinal: "Delete permanently",
    },
  },
  timeline: timelineMessages.en,
  home: homeMessages.en,
  map: mapMessages.en,
  editor: editorMessages.en,
  calendar: calendarMessages.en,
  overview: overviewMessages.en,
  media: mediaMessages.en,
  onThisDay: onThisDayMessages.en,
  detail: detailMessages.en,
  theme: themeMessages.en,
  commandPalette: commandPaletteMessages.en,
  sidebar: sidebarMessages.en,
  login: loginMessages.en,
  lock: lockMessages.en,
  swUpdate: swUpdateMessages.en,
  conflictCopies: conflictCopiesMessages.en,
  share: shareMessages.en,
  sync: syncMessages.en,
  errors: errorsMessages.en,
  errorPage: errorPageMessages.en,
}
