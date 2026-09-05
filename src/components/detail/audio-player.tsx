"use client"

import { useState, useRef, useEffect } from "react"
import { Play, Pause, Music } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatDuration } from "@/lib/format"
import type { Media } from "@/types/journal"
import { useI18n } from "@/components/locale-provider"

interface AudioPlayerProps {
  media: Media
}

export function AudioPlayer({ media }: AudioPlayerProps) {
  const { messages } = useI18n()
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(media.durationSeconds ?? 0)
  const [error, setError] = useState(false)
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => setDuration(audio.duration)
    const onEnded = () => setIsPlaying(false)
    const onError = () => setError(true)

    audio.addEventListener("timeupdate", onTimeUpdate)
    audio.addEventListener("loadedmetadata", onLoadedMetadata)
    audio.addEventListener("ended", onEnded)
    audio.addEventListener("error", onError)

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate)
      audio.removeEventListener("loadedmetadata", onLoadedMetadata)
      audio.removeEventListener("ended", onEnded)
      audio.removeEventListener("error", onError)
    }
  }, [])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      // Erst nach erfolgreichem play() umschalten — bei einer Rejection
      // (Decode-Fehler, Autoplay-Sperre) blieb der Button sonst auf "Pause"
      // stehen, obwohl nichts spielt.
      audio.play()
        .then(() => setIsPlaying(true))
        .catch((err) => console.warn("[audio-player] play() failed:", err))
    }
  }

  function handleScrub(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current
    const bar = progressRef.current
    if (!audio || !bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = ratio * duration
    setCurrentTime(audio.currentTime)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  if (error) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/40">
        <Music className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-ui text-muted-foreground">{messages.detail.audio.unavailable}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/40">
      <audio ref={audioRef} src={media.filePath} preload="metadata" />

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-full hover:bg-primary/10 text-primary"
        onClick={togglePlay}
        aria-label={isPlaying ? messages.detail.audio.pause : messages.detail.audio.play}
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </Button>

      <div className="flex-1 space-y-1.5 min-w-0">
        {/* Scrubable progress bar */}
        <div
          ref={progressRef}
          className="relative h-1.5 w-full rounded-full bg-border cursor-pointer group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
          onClick={handleScrub}
          tabIndex={0}
          role="slider"
          aria-valuenow={Math.round(currentTime)}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-label={messages.detail.audio.position}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-75"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-primary shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        </div>
        <div className="flex justify-between text-[11px] font-ui text-muted-foreground tabular-nums">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  )
}
