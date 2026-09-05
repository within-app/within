"use client"

import { useState } from "react"
import { format } from "date-fns"
import { entryTimeString, entryWallClockDate, withEntryDay, withEntryTime } from "@/lib/editor/entry-date"
import { CalendarIcon, Heart, Loader2, LocateFixed } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { TagCombobox } from "@/components/editor/tag-combobox"
import { useGeolocation } from "@/hooks/use-geolocation"
import { formatCoord } from "@/lib/geolocation"
import { useI18n } from "@/components/locale-provider"
import { getDateFnsLocale } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import type { Journal, Tag } from "@/types/journal"

interface MetadataPanelProps {
  journals: Journal[]
  journalId: string
  onJournalChange: (id: string) => void
  createdAt: Date
  onDateChange: (date: Date) => void
  starred: boolean
  onStarredChange: (starred: boolean) => void
  tags: Tag[]
  onTagsChange: (tags: Tag[]) => void
  locationName: string
  onLocationNameChange: (v: string) => void
  locationLat: string
  onLocationLatChange: (v: string) => void
  locationLng: string
  onLocationLngChange: (v: string) => void
}

export function MetadataPanel({
  journals,
  journalId,
  onJournalChange,
  createdAt,
  onDateChange,
  starred,
  onStarredChange,
  tags,
  onTagsChange,
  locationName,
  onLocationNameChange,
  locationLat,
  onLocationLatChange,
  locationLng,
  onLocationLngChange,
}: MetadataPanelProps) {
  const [calendarOpen, setCalendarOpen] = useState(false)
  const { isAvailable: geoAvailable, isLocating, error: geoError, requestPosition } = useGeolocation()
  const { messages, locale } = useI18n()

  async function handleUseGps() {
    const pos = await requestPosition()
    if (!pos) return
    onLocationLatChange(formatCoord(pos.lat))
    onLocationLngChange(formatCoord(pos.lng))
  }

  // Datum und Uhrzeit sind Wanduhr-Felder der App-Zone (src/lib/editor/entry-date.ts),
  // nicht der Gerätezeitzone — sonst weicht der Editor von Zeitleiste und Detail ab.
  const wallClock = entryWallClockDate(createdAt)
  const timeString = entryTimeString(createdAt)

  function handleTimeChange(value: string) {
    const next = withEntryTime(createdAt, value)
    if (next) onDateChange(next)
  }

  function handleDaySelect(day: Date | undefined) {
    if (!day) return
    onDateChange(withEntryDay(createdAt, day))
    setCalendarOpen(false)
  }

  return (
    <div className="space-y-5">
      {/* Journal */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">{messages.editor.metadata.journalLabel}</Label>
        <Select value={journalId} onValueChange={onJournalChange}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder={messages.editor.metadata.journalPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {journals.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: j.color }}
                  />
                  {j.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Date + Time */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">{messages.editor.metadata.dateTimeLabel}</Label>
        <div className="flex gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn("flex-1 h-9 justify-start text-left font-normal text-sm", !createdAt && "text-muted-foreground")}
              >
                <CalendarIcon className="mr-2 h-3.5 w-3.5 shrink-0 opacity-70" />
                {format(wallClock, messages.date.numeric, { locale: getDateFnsLocale(locale) })}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={wallClock}
                onSelect={handleDaySelect}
                initialFocus
                locale={getDateFnsLocale(locale)}
                fromYear={1900}
                toYear={2100}
              />
            </PopoverContent>
          </Popover>

          <Input
            type="time"
            value={timeString}
            onChange={(e) => handleTimeChange(e.target.value)}
            className="w-24 h-9 text-sm"
          />
        </div>
      </div>

      <Separator />

      {/* Starred */}
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">{messages.editor.metadata.favoriteLabel}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onStarredChange(!starred)}
          className={cn("gap-1.5 h-8", starred && "text-heart")}
          aria-label={starred ? messages.editor.metadata.favoriteAriaOn : messages.editor.metadata.favoriteAriaOff}
        >
          <Heart className={cn("h-4 w-4", starred && "fill-heart")} />
          {starred ? messages.editor.metadata.favoriteOn : messages.editor.metadata.favoriteOff}
        </Button>
      </div>

      <Separator />

      {/* Tags */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">{messages.editor.metadata.tagsLabel}</Label>
        <TagCombobox selectedTags={tags} onChange={onTagsChange} />
      </div>

      <Separator />

      {/* Standort */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">{messages.editor.metadata.locationLabel}</Label>
        <Input
          placeholder={messages.editor.metadata.locationNamePlaceholder}
          value={locationName}
          onChange={(e) => onLocationNameChange(e.target.value)}
          className="h-9 text-sm"
        />
        <div className="flex gap-2">
          <Input
            placeholder={messages.editor.metadata.locationLatPlaceholder}
            value={locationLat}
            onChange={(e) => onLocationLatChange(e.target.value)}
            className="h-9 text-sm"
            type="number"
            step="any"
          />
          <Input
            placeholder={messages.editor.metadata.locationLngPlaceholder}
            value={locationLng}
            onChange={(e) => onLocationLngChange(e.target.value)}
            className="h-9 text-sm"
            type="number"
            step="any"
          />
        </div>
        {geoAvailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleUseGps}
            disabled={isLocating}
            className="w-full h-9 gap-1.5"
          >
            {isLocating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LocateFixed className="h-4 w-4" />
            )}
            {isLocating ? messages.editor.metadata.locating : messages.editor.metadata.useGps}
          </Button>
        )}
        {geoError && (
          <p className="text-[11px] text-destructive">{messages.editor.geoErrors[geoError]}</p>
        )}
        <p className="text-[11px] text-muted-foreground/60">
          {messages.editor.metadata.coordsHint}
        </p>
      </div>
    </div>
  )
}
