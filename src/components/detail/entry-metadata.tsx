import { MapPin, Sun, CloudSun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { formatCoord } from "@/lib/geolocation"
import type { LocationInfo, WeatherIcon, WeatherInfo, Tag } from "@/types/journal"

const WEATHER_ICONS: Record<WeatherIcon, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  sunny: Sun,
  "partly-cloudy": CloudSun,
  cloudy: Cloud,
  rainy: CloudRain,
  stormy: CloudLightning,
  snowy: Snowflake,
  foggy: CloudFog,
}

/** Chip label: the place name, or formatted coordinates for GPS-only locations. */
export function locationLabel(location?: LocationInfo): string | null {
  if (!location) return null
  if (location.name) return location.name
  if (location.latitude != null && location.longitude != null) {
    return `${formatCoord(location.latitude)}, ${formatCoord(location.longitude)}`
  }
  return null
}

// iOS system tints for weather status (hex, matches globals.css --ios-* values)
const WEATHER_COLORS: Record<string, string> = {
  sunny:           "#FFCC00", // --ios-yellow
  "partly-cloudy": "#FF9500", // --ios-orange
  cloudy:          "#8E8E93", // neutral gray
  rainy:           "#5AC8FA", // --ios-teal
  stormy:          "#5856D6", // --ios-indigo
  snowy:           "#4DA6FF", // --blue-400
  foggy:           "#8E8E93", // neutral gray
}

function weatherColor(icon: string): string {
  return WEATHER_COLORS[icon] ?? "#5AC8FA"
}

// Deterministic iOS-palette color for tags (mirrors entry-card.tsx)
const TAG_PALETTE = [
  "#FF3B30", "#FF9500", "#FFCC00", "#34C759",
  "#007AFF", "#5856D6", "#FF2D55", "#AF52DE",
]

function tagPaletteColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

function WeatherGlyph({ icon, className, style }: { icon: string; className?: string; style?: React.CSSProperties }) {
  const Icon = WEATHER_ICONS[icon as WeatherIcon] ?? Sun
  return <Icon className={className} style={style} />
}

interface EntryMetadataProps {
  location?: LocationInfo
  weather?: WeatherInfo
  tags: Tag[]
  journalName: string
  journalColor: string
}

export function EntryMetadata({
  location,
  weather,
  tags,
  journalName,
  journalColor,
}: EntryMetadataProps) {
  const locationText = locationLabel(location)
  const hasAny = locationText || weather || tags.length > 0

  return (
    <div className="space-y-4">
      {hasAny && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Location chip — iOS teal tint */}
          {locationText && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[12px] font-ui font-medium leading-none text-foreground/80 bg-ios-teal/10"
            >
              <MapPin
                className="h-[11px] w-[11px] shrink-0 text-ios-teal"
              />
              {locationText}
            </span>
          )}

          {/* Weather chip — iOS status tint from icon type */}
          {weather && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[12px] font-ui font-medium leading-none text-foreground/80"
              style={{ backgroundColor: `${weatherColor(weather.icon)}18` }}
            >
              <WeatherGlyph
                icon={weather.icon}
                className="h-[11px] w-[11px] shrink-0"
                style={{ color: weatherColor(weather.icon) }}
              />
              {weather.temperatureCelsius !== null && (
                <span className="tabular-nums">{weather.temperatureCelsius}°</span>
              )}
              {weather.description && (
                <span className="text-foreground/60">{weather.description}</span>
              )}
            </span>
          )}

          {/* Tag pills — iOS system tints (deterministic by name hash) */}
          {tags.map((tag) => {
            const color = tagPaletteColor(tag.name)
            return (
              <span
                key={tag.id}
                className="inline-flex items-center rounded-full px-2.5 py-[5px] text-[12px] font-ui font-medium leading-none"
                style={{
                  color,
                  backgroundColor: `${color}1A`,
                }}
              >
                {tag.name}
              </span>
            )
          })}
        </div>
      )}

      {/* Journal attribution */}
      <div className="flex items-center gap-2 text-[12px] font-ui text-muted-foreground">
        <Avatar className="h-[14px] w-[14px]">
          <AvatarFallback
            className="text-[8px] font-semibold text-white"
            style={{ backgroundColor: journalColor }}
          >
            {journalName[0]}
          </AvatarFallback>
        </Avatar>
        <span>{journalName}</span>
      </div>
    </div>
  )
}
