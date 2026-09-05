"use client"

import { useState, useEffect, useCallback } from "react"
import { useTheme } from "next-themes"
import {
  PencilLine, BookOpen, Globe2, Camera, LayoutList, CalendarDays,
  Sun, Moon, Monitor, Search,
} from "lucide-react"
import { format } from "date-fns"
import { toZonedDate } from "@/lib/timezone"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { nextTheme, type ThemeMode } from "@/lib/theme-cycle"
import { useI18n } from "@/components/locale-provider"
import { useOnline } from "@/hooks/use-online"
import { getDateFnsLocale } from "@/lib/i18n"
import type { Journal, ViewMode, TimelineEntry } from "@/types/journal"

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  journals: Journal[]
  journalId: string | null
  onJournalSelect: (id: string | null) => void
  viewMode?: ViewMode
  onViewChange: (mode: ViewMode) => void
  onNewEntry: () => void
  onEntrySelect: (id: string) => void
}

const VIEW_ITEMS: { mode: ViewMode; icon: React.ReactNode }[] = [
  { mode: "timeline", icon: <LayoutList className="h-4 w-4" /> },
  { mode: "overview", icon: <BookOpen className="h-4 w-4" /> },
  { mode: "calendar", icon: <CalendarDays className="h-4 w-4" /> },
  { mode: "media", icon: <Camera className="h-4 w-4" /> },
  { mode: "map", icon: <Globe2 className="h-4 w-4" /> },
]

const THEME_ICONS: Record<ThemeMode, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
}

export function CommandPalette({
  open,
  onOpenChange,
  journals,
  journalId,
  onJournalSelect,
  viewMode,
  onViewChange,
  onNewEntry,
  onEntrySelect,
}: CommandPaletteProps) {
  const { theme, setTheme } = useTheme()
  const { messages, locale } = useI18n()
  const online = useOnline() // Karte ist online-gebunden (s. timeline-toolbar)
  const [query, setQuery] = useState("")
  const [entryResults, setEntryResults] = useState<TimelineEntry[]>([])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setEntryResults([])
    }
  }, [open])

  useEffect(() => {
    if (query.trim().length < 2) {
      setEntryResults([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/entries?q=${encodeURIComponent(query.trim())}&perPage=8`,
          { signal: controller.signal }
        )
        if (!res.ok) return
        const data = await res.json()
        const entries: TimelineEntry[] = (
          (data.dateGroups ?? []) as Array<{ entries: TimelineEntry[] }>
        )
          .flatMap((g) => g.entries)
          .slice(0, 8)
        setEntryResults(entries)
      } catch {
        // aborted or network error
      }
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  const currentTheme = (theme ?? "system") as ThemeMode
  const next = nextTheme(currentTheme)

  const q = query.toLowerCase().trim()
  const matches = (text: string) => !q || text.toLowerCase().includes(q)

  const actionItems = [
    {
      id: "new",
      label: messages.commandPalette.newEntry,
      shortcut: "⌘N",
      icon: <PencilLine className="h-4 w-4" />,
      action: () => { onNewEntry(); close() },
    },
    ...VIEW_ITEMS.filter((v) => v.mode !== viewMode && (online || v.mode !== "map")).map((v) => ({
      id: `view-${v.mode}`,
      label: messages.commandPalette.viewAction(messages.commandPalette.views[v.mode]),
      shortcut: undefined as string | undefined,
      icon: v.icon,
      action: () => { onViewChange(v.mode); close() },
    })),
    {
      id: "theme",
      label: messages.commandPalette.themeAction(messages.theme[next]),
      shortcut: undefined as string | undefined,
      icon: THEME_ICONS[next],
      action: () => { setTheme(next); close() },
    },
  ].filter((item) => matches(item.label))

  const journalItems = [
    {
      id: "all",
      label: messages.commandPalette.allEntries,
      color: null as string | null,
      action: () => { onJournalSelect(null); close() },
    },
    ...journals.map((j) => ({
      id: j.id,
      label: j.name,
      color: j.color,
      action: () => { onJournalSelect(j.id); close() },
    })),
  ].filter((item) => matches(item.label))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg max-w-[560px]" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{messages.commandPalette.title}</DialogTitle>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            placeholder={messages.commandPalette.searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{messages.commandPalette.noResults}</CommandEmpty>

            {actionItems.length > 0 && (
              <CommandGroup heading={messages.commandPalette.groups.actions}>
                {actionItems.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={item.action}>
                    {item.icon}
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <kbd className="ml-auto pointer-events-none select-none text-[10px] font-mono opacity-50">
                        {item.shortcut}
                      </kbd>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {journalItems.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={messages.commandPalette.groups.journals}>
                  {journalItems.map((item) => (
                    <CommandItem key={item.id} value={item.id} onSelect={item.action}>
                      {item.color ? (
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                      ) : (
                        <BookOpen className="h-4 w-4" />
                      )}
                      <span>{item.label}</span>
                      {(item.id === journalId ||
                        (item.id === "all" && !journalId)) && (
                        <span className="ml-auto text-[11px] text-muted-foreground opacity-60">
                          {messages.commandPalette.active}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {entryResults.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={messages.commandPalette.groups.entries}>
                  {entryResults.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      onSelect={() => {
                        onEntrySelect(entry.id)
                        close()
                      }}
                    >
                      <Search className="h-4 w-4" />
                      <span>
                        {entry.title ||
                          format(toZonedDate(new Date(entry.createdAt)), messages.date.dayMonthYear, {
                            locale: getDateFnsLocale(locale),
                          })}
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground opacity-60">
                        {format(toZonedDate(new Date(entry.createdAt)), messages.date.numericShort, {
                          locale: getDateFnsLocale(locale),
                        })}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
