"use client"

import { memo, useCallback, useState } from "react"
import { Heart, ImageOff, Clock, MapPin, Thermometer, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatEntryTime, formatEntryCardDate, formatEntryDate } from "@/lib/format"
import { tagColor } from "@/lib/tag-color"
import { useI18n } from "@/components/locale-provider"
import type { DateGroup, TimelineEntry } from "@/types/journal"

/** Pure class helpers — exported for unit testing. */
export function entryCardButtonClasses(isSelected: boolean, hasOnSelect: boolean): string {
  return cn(
    "w-full text-left flex items-stretch",
    "border-b border-border/25 last:border-0",
    "border-l-[3px]",
    "transition-colors duration-fast",
    isSelected
      ? ["bg-primary/10", "border-l-primary"]
      : ["hover:bg-accent/30", "border-l-transparent"],
    !hasOnSelect && "cursor-default"
  )
}

export function entryCardTitleClasses(isSelected: boolean, hasTitle: boolean): string {
  return cn(
    "flex-1 text-[14px] leading-snug truncate",
    hasTitle
      ? ["font-semibold", isSelected ? "text-primary" : "text-foreground"]
      : "italic text-muted-foreground/55 font-normal"
  )
}

/** Pure helper — exported for unit testing. */
export function entryCardFavouriteClasses(): string {
  return "h-3 w-3 text-heart fill-heart shrink-0 mt-[2px]"
}

/** Pure helper — exported for unit testing. */
export function entryCardWeekdayClasses(): string {
  return "text-[10px] font-bold tracking-wide text-muted-foreground/70 uppercase leading-none"
}

interface EntryCardProps {
  entry: TimelineEntry
  isSelected?: boolean
  onSelect?: (id: string) => void
  showDate?: boolean
}

export const EntryCard = memo(function EntryCard({ entry, isSelected, onSelect, showDate = false }: EntryCardProps) {
  const { messages, locale } = useI18n()
  const { weekdayAbbr, dayNum } = formatEntryCardDate(entry.createdAt, locale)

  const { id } = entry
  const handleClick = useCallback(() => onSelect?.(id), [onSelect, id])

  const metaTime = formatEntryTime(entry.createdAt)

  return (
    <button
      onClick={handleClick}
      data-testid="entry-card"
      aria-label={messages.timeline.entryCard.ariaLabel(entry.title || messages.common.untitled, metaTime)}
      className={entryCardButtonClasses(!!isSelected, !!onSelect)}
    >
      {/* ── Date column ─────────────────────── */}
      <div className="shrink-0 w-[56px] flex flex-col items-center pt-[13px] pb-3 select-none">
        {showDate ? (
          <>
            <span className={entryCardWeekdayClasses()}>
              {weekdayAbbr}.
            </span>
            <span className={cn(
              "text-[25px] font-bold leading-none tabular-nums mt-[3px]",
              isSelected ? "text-primary" : "text-foreground/85"
            )}>
              {dayNum}
            </span>
          </>
        ) : (
          // Subtle continuation line for same-day subsequent entries
          <div className="w-px self-stretch bg-border/20 mt-0 mx-auto" />
        )}
      </div>

      {/* ── Content + Thumbnail ──────────────── */}
      <div className="flex flex-1 min-w-0 pt-[13px] pb-3 pr-3">
        <div className="flex-1 min-w-0">

          {/* Title */}
          <div className="flex items-start gap-1.5 min-w-0">
            <p className={entryCardTitleClasses(!!isSelected, !!entry.title)}>
              {entry.title || messages.common.untitled}
            </p>
            {entry.starred && (
              <Heart className={entryCardFavouriteClasses()} aria-hidden />
            )}
          </div>

          {/* Preview text */}
          {entry.previewText && (
            <p className="text-[12.5px] text-muted-foreground/70 leading-snug line-clamp-2 mt-[3px]">
              {entry.previewText}
            </p>
          )}

          {/* Context meta: time / location / weather — icon + text pairs */}
          <div className="flex items-center gap-[6px] flex-wrap mt-[5px] text-[10.5px] text-muted-foreground/65 leading-none">
            <span className="flex items-center gap-[3px]">
              <Clock className="h-[9px] w-[9px] shrink-0" aria-hidden />
              {metaTime}
            </span>
            {entry.pending && (
              <span className="flex items-center gap-[3px] text-primary/70" aria-label={messages.timeline.entryCard.pending}>
                <RefreshCw className="h-[9px] w-[9px] shrink-0" aria-hidden />
                {messages.timeline.entryCard.pending}
              </span>
            )}
            {entry.location && (
              <span className="flex items-center gap-[3px]">
                <MapPin className="h-[9px] w-[9px] shrink-0" aria-hidden />
                {entry.location}
              </span>
            )}
            {entry.weather && (
              <span className="flex items-center gap-[3px]">
                <Thermometer className="h-[9px] w-[9px] shrink-0" aria-hidden />
                {entry.weather.temperatureCelsius}°C {entry.weather.description}
              </span>
            )}
          </div>

          {/* Tags as subtle pills */}
          {entry.tags.length > 0 && (
            <div className="flex items-center gap-[4px] flex-wrap mt-[5px]">
              {entry.tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full px-[7px] py-[2px] text-[10px] font-medium leading-none bg-muted/50"
                  style={{ color: tagColor(tag) }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Thumbnail ───────────────────────── */}
        {entry.thumbnail && (
          <div className="relative shrink-0 w-[84px] h-[84px] ml-3 rounded-xl overflow-hidden self-start">
            <ThumbnailImage src={entry.thumbnail} />
            {entry.photoCount > 1 && (
              <div className="absolute bottom-1 right-1 bg-black/55 rounded-[4px] px-1.5 py-[3px]">
                <span className="text-[10px] text-white font-semibold leading-none tabular-nums">
                  {entry.photoCount}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </button>
  )
})

/** Tages-Karte: bis zu so viele „Zeit · Titel"-Zeilen, danach „+ n weitere". */
const DAY_CARD_LINES = 3

interface DayCardProps {
  group: DateGroup
  isSelected?: boolean
  onSelect?: (date: string) => void
}

/**
 * Tages-Karte: Ein Tag mit 2+ Einträgen ist EINE
 * Karte in der Timeline; der Klick öffnet die Tages-Vorschau (alle Einträge
 * vollständig, nur Lesen). Datumsspalte und Selektionszustand wie EntryCard.
 * Vertrag: `group.entries` kommt aufsteigend sortiert (buildFlatItems) — ein
 * Tag liest sich vorwärts, die Timeline zwischen den Tagen weiter rückwärts.
 */
export const DayCard = memo(function DayCard({ group, isSelected, onSelect }: DayCardProps) {
  const { messages, locale } = useI18n()
  const { entries, date } = group
  const first = entries[0]
  const { weekdayAbbr, dayNum } = formatEntryCardDate(first.createdAt, locale)
  const withPhoto = entries.find((e) => e.thumbnail)
  const photoCount = entries.reduce((n, e) => n + e.photoCount, 0)
  const shown = entries.slice(0, DAY_CARD_LINES)
  const more = entries.length - shown.length
  const countLabel = messages.common.entryCount(entries.length)
  const handleClick = useCallback(() => onSelect?.(date), [onSelect, date])

  return (
    <button
      onClick={handleClick}
      data-testid="day-card"
      data-date={date}
      // Datumstext über den UTC-Tagesschlüssel (Mittag-Anker), nicht über
      // createdAt: der wäre lokal formatiert und könnte vom Tag der Karte abweichen.
      aria-label={messages.timeline.dayCard.ariaLabel(formatEntryDate(`${date}T12:00:00.000Z`, locale), countLabel)}
      className={entryCardButtonClasses(!!isSelected, !!onSelect)}
    >
      {/* ── Date column (wie EntryCard) ─────────── */}
      <div className="shrink-0 w-[56px] flex flex-col items-center pt-[13px] pb-3 select-none">
        <span className={entryCardWeekdayClasses()}>{weekdayAbbr}.</span>
        <span className={cn(
          "text-[25px] font-bold leading-none tabular-nums mt-[3px]",
          isSelected ? "text-primary" : "text-foreground/85"
        )}>
          {dayNum}
        </span>
      </div>

      {/* ── Kopf + Zeilen + Thumbnail ───────────── */}
      <div className="flex flex-1 min-w-0 pt-[13px] pb-3 pr-3">
        <div className="flex-1 min-w-0">
          <p className={cn(
            "text-[10.5px] font-bold tracking-wide uppercase leading-none",
            isSelected ? "text-primary" : "text-muted-foreground/70"
          )}>
            {countLabel}
          </p>
          <ul className="mt-[7px] space-y-[4px]">
            {shown.map((e) => (
              <li key={e.id} className="flex items-baseline gap-[6px] min-w-0 text-[13.5px] leading-snug">
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/65">
                  {formatEntryTime(e.createdAt)}
                </span>
                <span className={cn(
                  "truncate",
                  e.title ? "font-medium text-foreground" : "italic text-muted-foreground/55"
                )}>
                  {e.title || messages.common.untitled}
                </span>
                {e.starred && <Heart className={entryCardFavouriteClasses()} aria-hidden />}
                {e.pending && (
                  <span className="flex items-center gap-[3px] shrink-0 text-[10px] text-primary/70" aria-label={messages.timeline.entryCard.pending}>
                    <RefreshCw className="h-[9px] w-[9px] shrink-0" aria-hidden />
                    {messages.timeline.entryCard.pending}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {more > 0 && (
            <p className="mt-[5px] text-[11px] text-muted-foreground/60 leading-none">
              {messages.timeline.dayCard.more(more)}
            </p>
          )}
        </div>

        {withPhoto && (
          <div className="relative shrink-0 w-[84px] h-[84px] ml-3 rounded-xl overflow-hidden self-start">
            <ThumbnailImage src={withPhoto.thumbnail!} />
            {photoCount > 1 && (
              <div className="absolute bottom-1 right-1 bg-black/55 rounded-[4px] px-1.5 py-[3px]">
                <span className="text-[10px] text-white font-semibold leading-none tabular-nums">
                  {photoCount}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </button>
  )
})

function ThumbnailImage({ src }: { src: string }) {
  // Bind the error to the src that failed, not to the component
  // instance — with revocable blob: URLs a card can legitimately fail once and
  // later receive a valid server thumbnail, which must render again.
  const [errorSrc, setErrorSrc] = useState<string | null>(null)
  if (errorSrc === src) {
    return (
      <div className="w-full h-full bg-muted flex items-center justify-center">
        <ImageOff className="h-5 w-5 text-muted-foreground/30" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setErrorSrc(src)}
    />
  )
}
