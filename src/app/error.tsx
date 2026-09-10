"use client"

import { ErrorFallback } from "@/components/error-fallback"

/** Segment error boundary — a ChunkLoadError after a deploy in an open tab
 *  was a white screen before this. */
export default function ErrorPage() {
  return <ErrorFallback />
}
