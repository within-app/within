"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import {
  ChevronLeft, Upload, Download, Trash2, AlertTriangle,
  CheckCircle2, XCircle, Loader2, Plus, Pencil,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useI18n } from "@/components/locale-provider"
import { apiErrorText, type ApiErrorBody } from "@/lib/i18n/api-errors"
import {
  BACKUP_STALE_HOURS,
  classifyBackupStatus,
  type BackupStatusLevel,
  type BackupStatusRow,
} from "@/lib/backup-status"
import { LOCALES, LANGUAGE_LABELS, isLocale } from "@/lib/i18n/config"
import { isDownscaleEnabled, setDownscaleEnabled } from "@/lib/upload-downscale"
import {
  PREVIEW_PERIODS,
  isPreviewPeriod,
  previewPeriodSince,
  readPreviewPeriod,
  runPreviewMirror,
  writePreviewPeriod,
  type PreviewPeriod,
} from "@/lib/offline/preview-mirror"
import { changeVaultPin, lockVault, MIN_PIN_LENGTH } from "@/lib/vault/vault"
import {
  IDLE_MINUTES_CHOICES,
  IDLE_MINUTES_DEFAULT,
  readIdleMinutes,
  writeIdleMinutes,
} from "@/lib/vault/lock-settings"
import type { Journal } from "@/types/journal"

const JOURNAL_COLORS = [
  "#007AFF", "#FF9500", "#34C759", "#FF3B30",
  "#AF52DE", "#FF2D55", "#FFCC00", "#5AC8FA",
]

// ── Language Section ────────────────────────────────────────────────────────

function LanguageSection() {
  const { locale, setLocale, messages } = useI18n()
  const m = messages.settings.language

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={locale} onValueChange={(v) => { if (isLocale(v)) setLocale(v) }}>
          <SelectTrigger className="w-full max-w-xs" aria-label={m.title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((l) => (
              <SelectItem key={l} value={l}>{LANGUAGE_LABELS[l]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  )
}

// ── Uploads Section (Geräte-Einstellung, localStorage) ──────────────────────

function UploadsSection() {
  const { messages } = useI18n()
  const m = messages.settings.uploads
  const [downscale, setDownscale] = useState(false)

  // localStorage erst nach Mount lesen — SSR kennt den Gerätewert nicht.
  useEffect(() => {
    try {
      setDownscale(isDownscaleEnabled(window.localStorage))
    } catch { /* localStorage nicht verfügbar — Schalter bleibt aus */ }
  }, [])

  function handleToggle(enabled: boolean) {
    setDownscale(enabled)
    try {
      setDownscaleEnabled(window.localStorage, enabled)
    } catch { /* localStorage nicht verfügbar */ }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="upload-downscale">{m.downscaleLabel}</Label>
            <p className="text-sm text-muted-foreground">{m.downscaleHint}</p>
          </div>
          <Switch
            id="upload-downscale"
            checked={downscale}
            onCheckedChange={handleToggle}
            aria-label={m.downscaleLabel}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ── Offline-Vorschauen (E1 24.08.: Zeitraum-Spiegel, meta-Store) ────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

type PreviewStats = { count: number; bytes: number }

function OfflinePreviewsSection() {
  const { messages } = useI18n()
  const m = messages.settings.offlinePreviews
  const [period, setPeriod] = useState<PreviewPeriod>("off")
  // Ergebnis trägt den Zeitraum, für den es gilt — „lädt" ist abgeleitet
  // (stats.period !== period), kein synchrones setState im Effect nötig.
  const [stats, setStats] = useState<{ period: PreviewPeriod; data: PreviewStats | "error" } | null>(null)

  const periodLabels: Record<PreviewPeriod, string> = {
    off: m.periodOff,
    "1m": m.period1m,
    "3m": m.period3m,
    "6m": m.period6m,
    "1y": m.period1y,
    "2y": m.period2y,
    all: m.periodAll,
  }

  // Persistenz im verschlüsselten meta-Store — erst nach Mount lesen
  // (SSR kennt weder IDB noch den entsperrten Vault).
  useEffect(() => {
    readPreviewPeriod().then(setPeriod).catch(() => {})
  }, [])

  // Speicher-Info: SOLL-Zustand des Zeitraums aus echten Server-Zahlen
  // (GET /api/media/preview-stats), nicht der Cache-Ist auf dem Gerät.
  useEffect(() => {
    if (period === "off") return
    let cancelled = false
    const since = previewPeriodSince(period, new Date())
    const params = since ? `?since=${encodeURIComponent(since)}` : ""
    fetch(`/api/media/preview-stats${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`preview-stats failed: ${r.status}`)
        return r.json()
      })
      .then((data: PreviewStats) => {
        if (!cancelled) setStats({ period, data })
      })
      .catch(() => {
        if (!cancelled) setStats({ period, data: "error" })
      })
    return () => {
      cancelled = true
    }
  }, [period])

  const onPeriodChange = async (value: string) => {
    if (!isPreviewPeriod(value)) return
    setPeriod(value)
    try {
      await writePreviewPeriod(value)
      // Sofort wirksam: Spiegel-Lauf lädt den neuen Zeitraum bzw. räumt
      // beim Verkleinern/Aus die eigenen Einträge (nie Pin-Bytes).
      void runPreviewMirror({ force: true }).catch(() => {})
    } catch {
      // Vault gesperrt o.ä. — der nächste Unlock-Lauf übernimmt.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Label htmlFor="preview-period" className="shrink-0">
            {m.periodLabel}
          </Label>
          <Select value={period} onValueChange={onPeriodChange}>
            <SelectTrigger id="preview-period" className="w-full max-w-xs" aria-label={m.periodLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREVIEW_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {periodLabels[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="preview-storage-info">
          {period === "off"
            ? m.storageOff
            : stats?.period !== period
              ? m.loading
              : stats.data === "error"
                ? m.storageUnavailable
                : m.storageInfo(stats.data.count, formatBytes(stats.data.bytes))}
        </p>
        {period !== "off" && stats?.period === period && stats.data !== "error" && (
          <p className="text-xs text-muted-foreground/70">{m.storageHint}</p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Security Section (Geräte-Einstellung: App-Sperre + Vault) ───────────────

function SecuritySection() {
  const { messages } = useI18n()
  const m = messages.settings.security
  const [idleMinutes, setIdleMinutes] = useState(IDLE_MINUTES_DEFAULT)
  const [currentPin, setCurrentPin] = useState("")
  const [newPin, setNewPin] = useState("")
  const [confirmPin, setConfirmPin] = useState("")
  const [changing, setChanging] = useState(false)
  const [pinStatus, setPinStatus] = useState<{ ok: boolean; text: string } | null>(null)

  // localStorage erst nach Mount lesen — SSR kennt den Gerätewert nicht.
  useEffect(() => {
    try {
      setIdleMinutes(readIdleMinutes(window.localStorage))
    } catch { /* localStorage nicht verfügbar — Default bleibt */ }
  }, [])

  function handleIdleChange(value: string) {
    const minutes = Number.parseInt(value, 10)
    setIdleMinutes(minutes)
    try {
      writeIdleMinutes(window.localStorage, minutes)
    } catch { /* localStorage nicht verfügbar */ }
  }

  async function handleChangePin(e: React.FormEvent) {
    e.preventDefault()
    setPinStatus(null)
    if (newPin.length < MIN_PIN_LENGTH) {
      setPinStatus({ ok: false, text: messages.lock.pinTooShort(MIN_PIN_LENGTH) })
      return
    }
    if (newPin !== confirmPin) {
      setPinStatus({ ok: false, text: messages.lock.pinMismatch })
      return
    }
    setChanging(true)
    try {
      const ok = await changeVaultPin(currentPin, newPin)
      if (ok) {
        setPinStatus({ ok: true, text: m.pinChanged })
        setCurrentPin("")
        setNewPin("")
        setConfirmPin("")
      } else {
        setPinStatus({ ok: false, text: m.wrongCurrentPin })
      }
    } catch (err) {
      setPinStatus({
        ok: false,
        text: err instanceof Error ? err.message : messages.common.unknownError,
      })
    } finally {
      setChanging(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="auto-lock-minutes" className="pt-2">{m.autoLockLabel}</Label>
          <Select value={String(idleMinutes)} onValueChange={handleIdleChange}>
            <SelectTrigger id="auto-lock-minutes" className="w-40" aria-label={m.autoLockLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IDLE_MINUTES_CHOICES.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {m.autoLockMinutes(minutes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" onClick={() => lockVault()}>
          {m.lockNow}
        </Button>

        <form onSubmit={handleChangePin} className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">{m.changePinTitle}</p>
          <div className="space-y-2">
            <Label htmlFor="vault-current-pin">{m.currentPin}</Label>
            <Input
              id="vault-current-pin"
              type="password"
              autoComplete="off"
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value)}
              disabled={changing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vault-new-pin">{m.newPin}</Label>
            <Input
              id="vault-new-pin"
              type="password"
              autoComplete="new-password"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              disabled={changing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vault-confirm-pin">{m.confirmNewPin}</Label>
            <Input
              id="vault-confirm-pin"
              type="password"
              autoComplete="new-password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              disabled={changing}
            />
          </div>
          {pinStatus && (
            <p className={`text-sm ${pinStatus.ok ? "text-muted-foreground" : "text-destructive"}`}>
              {pinStatus.text}
            </p>
          )}
          <Button type="submit" disabled={changing || !currentPin || !newPin || !confirmPin}>
            {changing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {m.changing}
              </>
            ) : (
              m.changePin
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

// ── Backup Section (server state, read-only) ─

function BackupSection() {
  const { messages, locale } = useI18n()
  const m = messages.settings.backup
  const [level, setLevel] = useState<BackupStatusLevel | "loading">("loading")
  const [row, setRow] = useState<BackupStatusRow | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/backup/status")
        const body = res.ok ? ((await res.json()) as BackupStatusRow) : null
        if (cancelled) return
        setRow(body)
        setLevel(classifyBackupStatus(body, res.status, new Date()))
      } catch {
        if (!cancelled) setLevel("unavailable")
      }
    })()
    return () => { cancelled = true }
  }, [])

  const bad = level === "error" || level === "stale"
  const statusText =
    level === "ok" ? m.statusOk
    : level === "stale" ? m.statusStale(BACKUP_STALE_HOURS)
    : level === "error" ? m.statusError
    : level === "none" ? m.statusNone
    : level === "unavailable" ? m.statusUnavailable
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {level === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <>
            <div className="flex items-center gap-2">
              {level === "ok" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
              ) : bad ? (
                <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <p className={cn("text-sm", bad && "text-destructive")}>{statusText}</p>
            </div>
            {row?.run_at && level !== "none" && (
              <p className="text-sm text-muted-foreground">
                {m.lastRun(new Date(row.run_at).toLocaleString(locale))}
              </p>
            )}
            {level === "error" && row?.error_msg && (
              <p className="text-sm text-muted-foreground break-words">{row.error_msg}</p>
            )}
            {level === "ok" &&
              typeof row?.verify_entry_count === "number" &&
              typeof row?.verify_media_count === "number" && (
                <p className="text-sm text-muted-foreground">
                  {m.verifiedCounts(row.verify_entry_count, row.verify_media_count)}
                </p>
              )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Import Section ──────────────────────────────────────────────────────────

function ImportSection({ journals }: { journals: Journal[] }) {
  const { messages } = useI18n()
  const m = messages.settings.import
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [selectedJournalId, setSelectedJournalId] = useState<string>("__auto__")
  const [journalName, setJournalName] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [result, setResult] = useState<{
    imported: number; skipped: number; errors: string[]; warnings?: string[]; duration: number
  } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleImport() {
    if (!file) return
    setStatus("loading")
    setResult(null)
    setErrorMsg(null)
    const params = new URLSearchParams()
    if (selectedJournalId && selectedJournalId !== "__auto__") {
      params.set("journalId", selectedJournalId)
    } else if (journalName.trim()) {
      params.set("journalName", journalName.trim())
    }
    const url = params.size > 0 ? `/api/import?${params}` : "/api/import"
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file, // raw File/Blob — no FormData, no multipart envelope
      })
      const data = await res.json()
      if (!res.ok) {
        setErrorMsg(apiErrorText(messages, data as ApiErrorBody, messages.common.unknownError))
        setStatus("error")
        return
      }
      setResult(data)
      setStatus("done")
    } catch {
      setErrorMsg(m.networkError)
      setStatus("error")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Journal selector */}
        <div className="space-y-1.5">
          <Label htmlFor="import-journal">{m.targetJournal}</Label>
          <Select value={selectedJournalId} onValueChange={setSelectedJournalId}>
            <SelectTrigger id="import-journal" className="w-full max-w-xs">
              <SelectValue placeholder={m.autoOption} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">{m.autoOption}</SelectItem>
              {journals.map((j) => (
                <SelectItem key={j.id} value={j.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded shrink-0"
                      style={{ backgroundColor: j.color }}
                    />
                    {j.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Name for the auto-created journal — only relevant on the auto path */}
        {selectedJournalId === "__auto__" && (
          <div className="space-y-1.5">
            <Label htmlFor="import-journal-name">{m.journalNameLabel}</Label>
            <Input
              id="import-journal-name"
              value={journalName}
              onChange={(e) => setJournalName(e.target.value)}
              placeholder={m.journalNamePlaceholder}
              maxLength={200}
              className="max-w-xs"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            {file ? file.name : m.chooseZip}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setStatus("idle")
              setResult(null)
              setErrorMsg(null)
            }}
          />
          <Button
            onClick={handleImport}
            disabled={!file || status === "loading"}
            className="gap-2"
          >
            {status === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {m.running}
              </>
            ) : (
              m.start
            )}
          </Button>
        </div>

        {status === "done" && result && (
          <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-4 text-sm">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-green-800 dark:text-green-300">
                {m.doneIn((result.duration / 1000).toFixed(1))}
              </p>
              <p className="text-green-700 dark:text-green-400">
                {m.resultLine(result.imported, result.skipped)}
              </p>
              {result.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-yellow-700 dark:text-yellow-400">
                    {m.errorCount(result.errors.length)}
                  </summary>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs text-yellow-700 dark:text-yellow-400">
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </details>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-yellow-700 dark:text-yellow-400">
                    {m.warningCount(result.warnings.length)}
                  </summary>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs text-yellow-700 dark:text-yellow-400">
                    {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        {status === "error" && errorMsg && (
          <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-400">
            <XCircle className="h-5 w-5 shrink-0" />
            {errorMsg}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Export Section ──────────────────────────────────────────────────────────

function ExportSection({ journals }: { journals: Journal[] }) {
  const { messages } = useI18n()
  const m = messages.settings.export
  const [downloading, setDownloading] = useState<string | null>(null)

  function triggerDownload(url: string) {
    return new Promise<void>((resolve) => {
      const a = document.createElement("a")
      a.href = url
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(resolve, 500)
    })
  }

  async function handleExport(journalId: string | null) {
    const key = journalId ?? "all"
    setDownloading(key)
    try {
      await triggerDownload(journalId ? `/api/export?journalId=${journalId}` : "/api/export")
    } finally {
      setDownloading(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => handleExport(null)}
            disabled={downloading !== null}
          >
            {downloading === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {m.all}
          </Button>

          {journals.map((j) => (
            <Button
              key={j.id}
              variant="outline"
              className="gap-2"
              onClick={() => handleExport(j.id)}
              disabled={downloading !== null}
            >
              {downloading === j.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span className="inline-block h-3 w-3 rounded shrink-0" style={{ backgroundColor: j.color }} />
              {j.name}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Journal Section (Erstellen + Bearbeiten + Löschen) ──────────────────────

function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {JOURNAL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className="h-6 w-6 rounded transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          style={{
            backgroundColor: c,
            outline: value === c ? `2px solid ${c}` : "2px solid transparent",
            outlineOffset: "2px",
          }}
          aria-label={c}
          aria-pressed={value === c}
        />
      ))}
    </div>
  )
}

// Exported for the i18n render test (journal-rename-render.test.tsx).
export function JournalSection({
  journals,
  onRefresh,
}: {
  journals: Journal[]
  onRefresh: () => void
}) {
  const { messages } = useI18n()
  const m = messages.settings.journals
  const [name, setName] = useState("")
  const [color, setColor] = useState(JOURNAL_COLORS[0])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [confirmJournal, setConfirmJournal] = useState<Journal | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [editJournal, setEditJournal] = useState<Journal | null>(null)
  const [editName, setEditName] = useState("")
  const [editColor, setEditColor] = useState(JOURNAL_COLORS[0])
  const [isSaving, setIsSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch("/api/journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setCreateError(apiErrorText(messages, data as ApiErrorBody, m.createFailed))
        return
      }
      setName("")
      setColor(JOURNAL_COLORS[0])
      onRefresh()
    } catch {
      setCreateError(messages.common.networkError)
    } finally {
      setCreating(false)
    }
  }

  function openEdit(j: Journal) {
    setEditJournal(j)
    setEditName(j.name)
    setEditColor(j.color)
    setEditError(null)
  }

  async function handleSaveEdit() {
    if (!editJournal || !editName.trim()) return
    setIsSaving(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/journals/${editJournal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), color: editColor }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setEditError(apiErrorText(messages, data as ApiErrorBody, m.editFailed))
        return
      }
      setEditJournal(null)
      onRefresh()
    } catch {
      setEditError(messages.common.networkError)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirmJournal) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      // Netzwerkfehler UND non-2xx behandeln — vorher schloss sich der Dialog
      // bei einem Server-Fehler kommentarlos und das Journal war "wieder da".
      const res = await fetch(`/api/journals/${confirmJournal.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error(`journal delete failed: ${res.status}`)
      setConfirmJournal(null)
      onRefresh()
    } catch {
      setDeleteError(messages.common.networkError)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing journals */}
        <div className="rounded-lg border divide-y">
          {journals.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">{m.empty}</p>
          ) : (
            journals.map((j) => (
              <div key={j.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className="inline-block h-3 w-3 rounded shrink-0"
                    style={{ backgroundColor: j.color }}
                  />
                  <span className="font-medium">{j.name}</span>
                  <span className="text-muted-foreground">
                    · {m.entryCount(j.entryCount)}
                  </span>
                </div>
                <div className="flex items-center shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    aria-label={m.editAria(j.name)}
                    onClick={() => openEdit(j)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmJournal(j)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {m.delete}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Create new journal */}
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-sm font-medium">{m.createHeading}</p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="journal-name">{m.nameLabel}</Label>
              <Input
                id="journal-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={m.namePlaceholder}
                className="max-w-xs"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate() }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{m.colorLabel}</Label>
              <ColorSwatches value={color} onChange={setColor} />
            </div>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!name.trim() || creating}
              className="gap-1.5"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {m.create}
            </Button>
          </div>
          {createError && (
            <p className="text-sm text-destructive">{createError}</p>
          )}
        </div>

        {/* Edit name + colour */}
        <Dialog
          open={!!editJournal}
          onOpenChange={(open) => { if (!open) setEditJournal(null) }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{m.editTitle}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-journal-name">{m.nameLabel}</Label>
                <Input
                  id="edit-journal-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={m.namePlaceholder}
                  maxLength={200}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveEdit() }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{m.colorLabel}</Label>
                <ColorSwatches value={editColor} onChange={setEditColor} />
              </div>
              {editError && (
                <p className="text-sm text-destructive">{editError}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setEditJournal(null)}
                disabled={isSaving}
              >
                {messages.common.cancel}
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={!editName.trim() || isSaving}
                className="gap-1.5"
              >
                {isSaving ? (
                  <><Loader2 className="h-4 w-4 animate-spin" />{m.saving}</>
                ) : (
                  m.save
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog
          open={!!confirmJournal}
          onOpenChange={(open) => { if (!open) { setConfirmJournal(null); setDeleteError(null) } }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                {m.deleteConfirmTitle(confirmJournal?.name ?? "")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {m.deleteConfirmDescription(confirmJournal?.entryCount ?? 0)}
              </AlertDialogDescription>
              {deleteError && (
                <p className="text-sm text-destructive">{deleteError}</p>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>{messages.common.cancel}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />{m.deleting}</>
                ) : (
                  m.deleteFinal
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { messages } = useI18n()
  const [journals, setJournals] = useState<Journal[]>([])

  function loadJournals() {
    fetch("/api/journals")
      .then((r) => r.json())
      .then(setJournals)
      .catch(() => {})
  }

  useEffect(() => {
    loadJournals()
  }, [])

  return (
    // h-dvh + overflow-y-auto: body ist global overflow-hidden (layout.tsx),
    // die Seite braucht daher ihren eigenen Scroll-Container.
    <div className="h-dvh overflow-y-auto bg-background">
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6 page-enter">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild className="-ml-2">
            <Link href="/" aria-label={messages.settings.backToOverview}>
              <ChevronLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{messages.settings.title}</h1>
            <p className="text-sm text-muted-foreground">{messages.settings.subtitle}</p>
          </div>
        </div>

        <LanguageSection />
        <UploadsSection />
        <OfflinePreviewsSection />
        <SecuritySection />
        <BackupSection />
        <ImportSection journals={journals} />
        <ExportSection journals={journals} />
        <JournalSection journals={journals} onRefresh={loadJournals} />
      </div>
    </div>
  )
}
