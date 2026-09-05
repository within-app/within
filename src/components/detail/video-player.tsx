"use client"

import { useState } from "react"
import { Video } from "lucide-react"
import type { Media } from "@/types/journal"
import { useI18n } from "@/components/locale-provider"

interface VideoPlayerProps {
  media: Media
}

export function VideoPlayer({ media }: VideoPlayerProps) {
  const { messages } = useI18n()
  const [error, setError] = useState(false)

  if (error) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/40">
        <Video className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-ui text-muted-foreground">{messages.detail.video.unavailable}</span>
      </div>
    )
  }

  return (
    <div className="rounded-xl overflow-hidden border border-border bg-black shadow-sm">
      <video
        src={media.filePath}
        controls
        className="w-full max-h-[500px]"
        preload="metadata"
        poster={media.thumbnailPath}
        onError={() => setError(true)}
      />
    </div>
  )
}
