import type { WeatherIcon } from "@/types/journal"

const WEATHER_MAP: Record<string, WeatherIcon> = {
  "clear": "sunny",
  "mostly-clear": "sunny",
  "partly-cloudy": "partly-cloudy",
  "mostly-cloudy": "cloudy",
  "cloudy": "cloudy",
  "cloudy-windy": "cloudy",
  "windy": "cloudy",
  "rain": "rainy",
  "drizzle": "rainy",
  "heavy-rain": "rainy",
  "rain-windy": "rainy",
  "thunderstorms": "stormy",
  "thunderstorms-windy": "stormy",
  "snow": "snowy",
  "heavy-snow": "snowy",
  "flurries": "snowy",
  "sleet": "snowy",
  "blizzard": "snowy",
  "foggy": "foggy",
  "haze": "foggy",
  "smoke": "foggy",
}

export function mapWeatherCode(code: string | undefined): WeatherIcon {
  if (!code) return "cloudy"
  return WEATHER_MAP[code.toLowerCase()] ?? "cloudy"
}

export function toUUID(hex: string): string {
  const h = hex.toLowerCase().replace(/-/g, "")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function buildLocationName(loc: Record<string, string> | undefined): string | null {
  if (!loc) return null
  const parts = [loc.placeName, loc.localityName, loc.country].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : null
}
