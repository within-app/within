"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { BookOpen, Settings, LogOut, Sun, Moon, Monitor, Heart, Camera } from "lucide-react"
import { WithinMark } from "@/components/within-mark"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { type ThemeMode, nextTheme } from "@/lib/theme-cycle"
import { useI18n } from "@/components/locale-provider"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import type { Journal, ActiveFilters, Tag } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"
import { tagColor } from "@/lib/tag-color"

interface JournalSidebarProps {
  journals: Journal[]
  selectedJournalId: string | null
  onJournalSelect: (journalId: string | null) => void
  activeFilters: ActiveFilters
  onFiltersChange: (f: ActiveFilters) => void
  availableTags: Tag[]
}

export function JournalSidebar({
  journals,
  selectedJournalId,
  onJournalSelect,
  activeFilters,
  onFiltersChange,
  availableTags,
}: JournalSidebarProps) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const { messages } = useI18n()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const totalEntries = journals.reduce((sum, j) => sum + j.entryCount, 0)
  const currentTheme = (theme ?? "system") as ThemeMode
  const next = nextTheme(currentTheme)

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/login")
    router.refresh()
  }

  function handleAlleEintraege() {
    onJournalSelect(null)
    onFiltersChange(DEFAULT_FILTERS)
  }

  function handleFavoriten() {
    onJournalSelect(null)
    onFiltersChange({ ...DEFAULT_FILTERS, starred: true })
  }

  function handleMedien() {
    onJournalSelect(null)
    // "any" statt "photo": der Eintrag heißt Medien und muss auch Video und Audio
    // zeigen, sonst verspricht die Beschriftung mehr, als der Filter liefert.
    onFiltersChange({ ...DEFAULT_FILTERS, mediaType: "any" })
  }

  const noActiveFilter =
    !activeFilters.starred &&
    !activeFilters.mediaType &&
    activeFilters.tags.length === 0

  return (
    <Sidebar side="left" collapsible="icon" role="navigation" aria-label={messages.sidebar.navLabel}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="cursor-default">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <WithinMark className="size-4" />
              </div>
              <div className="flex flex-col gap-0.5 leading-none">
                <span className="font-semibold">Within</span>
                <span className="text-xs text-muted-foreground">
                  {messages.common.entryCount(totalEntries)}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Übersicht group */}
        <SidebarGroup>
          <SidebarGroupLabel>{messages.sidebar.overview}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={selectedJournalId === null && noActiveFilter}
                  onClick={handleAlleEintraege}
                  tooltip={messages.sidebar.allEntries}
                >
                  <BookOpen className="size-4" />
                  <span>{messages.sidebar.allEntries}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>{totalEntries}</SidebarMenuBadge>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeFilters.starred}
                  onClick={handleFavoriten}
                  tooltip={messages.sidebar.favourites}
                >
                  <Heart className="size-4" />
                  <span>{messages.sidebar.favourites}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeFilters.mediaType === "any"}
                  onClick={handleMedien}
                  tooltip={messages.sidebar.media}
                >
                  <Camera className="size-4" />
                  <span>{messages.sidebar.media}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Tags group — only shown when tags exist */}
        {availableTags.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{messages.sidebar.tags}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {availableTags.map((tag) => {
                  const color = tagColor(tag.name)
                  const isActive = activeFilters.tags.includes(tag.name)
                  return (
                    <SidebarMenuItem key={tag.id}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() =>
                          onFiltersChange({
                            ...activeFilters,
                            tags: isActive
                              ? activeFilters.tags.filter((t) => t !== tag.name)
                              : [...activeFilters.tags, tag.name],
                          })
                        }
                        tooltip={tag.name}
                      >
                        <span
                          className="size-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                          aria-hidden="true"
                        />
                        <span>{tag.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Journals group */}
        <SidebarGroup>
          <SidebarGroupLabel>{messages.sidebar.journals}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {journals.map((journal) => (
                <SidebarMenuItem key={journal.id}>
                  <SidebarMenuButton
                    isActive={selectedJournalId === journal.id}
                    onClick={() => onJournalSelect(journal.id)}
                    tooltip={journal.name}
                  >
                    <Avatar className="size-5">
                      <AvatarFallback
                        className="text-[10px] font-medium text-white"
                        style={{ backgroundColor: journal.color }}
                      >
                        {journal.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <span>{journal.name}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>{journal.entryCount}</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={messages.sidebar.settings}>
              <Link href="/settings">
                <Settings className="size-4" />
                <span>{messages.sidebar.settings}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={messages.sidebar.signOut} onClick={handleLogout}>
              <LogOut className="size-4" />
              <span>{messages.sidebar.signOut}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={messages.theme[currentTheme]}
              onClick={() => setTheme(next)}
              aria-label={messages.theme[currentTheme]}
            >
              {!mounted || currentTheme === "system" ? (
                <Monitor className="size-4" />
              ) : currentTheme === "light" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
              <span>{messages.theme[currentTheme]}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
