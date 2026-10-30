"use client"

import { FileText, ExternalLink, Download } from "lucide-react"
import { formatBytes } from "@/lib/format"
import type { Media } from "@/types/journal"
import { useI18n } from "@/components/locale-provider"

/** Pure helper — exported for unit testing. */
export function ensurePdfExtension(name: string): string {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}

interface PdfAttachmentProps {
  media: Media
}

/**
 * One PDF attachment below the entry text (2026-10-30).
 *
 * Within never renders the PDF itself: "Öffnen" hands the file to the
 * browser's own sandboxed viewer in a new tab (rel=noopener — the viewer tab
 * gets no window.opener back into the journal), "Herunterladen" saves it
 * under its display name. The display name is plain text — React escapes it.
 */
export function PdfAttachment({ media }: PdfAttachmentProps) {
  const { messages, locale } = useI18n()
  const t = messages.detail.pdf
  const name = media.originalName ?? t.fallbackName
  const size = formatBytes(media.sizeBytes, locale)
  // Day One exports the name without its extension ("20240101_Scan");
  // the saved file must still end in .pdf so the OS opens it correctly.
  const downloadName = media.originalName ? ensurePdfExtension(media.originalName) : ""
  const actionClasses =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/10 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/40">
      <FileText className="h-5 w-5 text-primary shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-ui truncate" title={name}>{name}</p>
        {size && (
          <p className="text-xs text-muted-foreground tabular-nums">{size} · PDF</p>
        )}
      </div>
      <a
        href={media.filePath}
        target="_blank"
        rel="noopener noreferrer"
        className={actionClasses}
        aria-label={t.openAria(name)}
        title={t.open}
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
      <a
        href={media.filePath}
        download={downloadName}
        className={actionClasses}
        aria-label={t.downloadAria(name)}
        title={t.download}
      >
        <Download className="h-4 w-4" aria-hidden />
      </a>
    </div>
  )
}
