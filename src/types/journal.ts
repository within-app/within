export type MediaType = "photo" | "audio" | "video"

export type WeatherIcon =
  | "sunny"
  | "partly-cloudy"
  | "cloudy"
  | "rainy"
  | "stormy"
  | "snowy"
  | "foggy"

export interface Journal {
  id: string
  name: string
  color: string
  entryCount: number
}

export interface Media {
  id: string
  entryId: string
  type: MediaType
  filePath: string
  thumbnailPath?: string
  order: number
  durationSeconds?: number
  /** Client-only. True for a file still waiting in the offline outbox —
   *  `filePath` is then a local object URL, not a server path. The API never sets
   *  this, so it needs no DB column and no sync-protocol field. */
  pending?: boolean
  /** The outbox id the file was uploaded under
   *  (media.client_media_id on server rows; the own outbox id on synthetic
   *  pending rows). The one key linking both worlds — lets the merge drop a
   *  pending row whose upload already landed. Absent/null on older rows created
   *  before this field existed. */
  clientMediaId?: string | null
  /** Client-only. True when the pending file has exhausted its
   *  upload retries — it will NOT go up on the next reconnect, and the UI must
   *  not promise otherwise. */
  uploadStuck?: boolean
  /** Client-only. Cause of the stuck upload, for the badge. */
  uploadError?: string
}

export interface WeatherInfo {
  description: string | null
  temperatureCelsius: number | null
  icon: string
}

export interface LocationInfo {
  /** Null for GPS-only locations — the picker stores coordinates without a name
   *  (no reverse geocoding by design), and those are still a full location. */
  name: string | null
  latitude?: number
  longitude?: number
}

export interface Tag {
  id: string
  name: string
}

export interface JournalEntry {
  id: string
  journalId: string
  text: string
  createdAt: string
  updatedAt: string
  revisionId?: string
  location?: LocationInfo
  weather?: WeatherInfo
  starred: boolean
  media: Media[]
  tags: Tag[]
}

export interface TimelineEntry {
  id: string
  journalId: string
  journalColor: string
  createdAt: string
  title: string
  previewText: string
  thumbnail?: string
  photoCount: number
  hasAudio: boolean
  hasVideo: boolean
  starred: boolean
  location?: string
  weather?: WeatherInfo
  tags: string[]
  /** True when the entry is in the local IDB queue and not yet synced to server. */
  pending?: boolean
}

/** Timeline entry enriched with the full markdown text and complete media
 *  list — returned by GET /api/entries?full=true (on-this-day reading view,
 *  one request per day instead of one detail fetch per entry). */
export interface FullTimelineEntry extends TimelineEntry {
  text: string
  media: Media[]
}

// Extended type returned by GET /api/entries/[id]
export interface JournalEntryDetail extends JournalEntry {
  journalName: string
  journalColor: string
}

export interface DateGroup {
  date: string
  formattedDate: string
  entries: TimelineEntry[]
}

export interface PaginatedTimeline {
  dateGroups: DateGroup[]
  totalEntries: number
  currentPage: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface MediaItem {
  id: string
  entryId: string
  type: MediaType
  filePath: string
  thumbnailPath?: string
  previewPath?: string
  durationSeconds?: number
  createdAt: string
  journalColor: string
  /** The outbox id the file was uploaded under — same contract as on
   *  `Media`. Server rows carry it from `media.client_media_id`, synthetic
   *  pending tiles their own outbox id; that pairing is what lets the overview
   *  drop a waiting tile whose upload already landed. */
  clientMediaId?: string | null
  /** Client-only. True for a file still waiting in the offline
   *  outbox — `filePath` is then a local object URL, not a server path. */
  pending?: boolean
  /** Client-only. True when the pending file has exhausted its
   *  upload retries — the tile must say "failed", not "waiting". */
  uploadStuck?: boolean
  /** Client-only. Cause of the stuck upload, for the badge. */
  uploadError?: string
}


export interface PaginatedMedia {
  photos: MediaItem[]
  totalCount: number
  page: number
  totalPages: number
}

// Richer per-day calendar data: count + optional photo thumbnail
export interface CalendarDayData {
  count: number
  thumbnail?: string // thumbnailPath if any entry on this day has a photo
}
export type CalendarData = Record<string, CalendarDayData>

export interface JournalStats {
  streak: number         // consecutive days with entries ending today
  totalEntries: number
  totalMedia: number | null // null = unknown (offline fallback has no media metadata)
  totalDays: number      // unique days with at least one entry
  totalCountries: number // unique countries extracted from location names
  onThisDayCount: number // entries whose month+day = today's month+day (all years)
}

export type ViewMode = "timeline" | "media" | "calendar" | "overview" | "map"

/** Media filter: one concrete type, "any" for entries with media of any kind, null for off. */
export type MediaFilter = MediaType | "any"

export interface ActiveFilters {
  starred: boolean
  tags: string[]
  mediaType: MediaFilter | null
  before: string | null  // YYYY-MM — jump to this month and earlier
  /** „Offline verfügbar": nur gepinnte Einträge — Quelle ist der
   *  lokale pinnedEntries-Store, nie der Server (muss im Flugmodus identisch
   *  funktionieren). */
  pinned: boolean
}

export const DEFAULT_FILTERS: ActiveFilters = {
  starred: false,
  tags: [],
  mediaType: null,
  before: null,
  pinned: false,
}

export interface MapMarker {
  id: string
  lat: number
  lng: number
  journalColor: string
  title: string
  createdAt: string
}
