"use client"

import { useEffect, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { buildShareDraft } from "@/lib/share/build-share-draft"
import { useI18n } from "@/components/locale-provider"

/**
 * Android share-to-within target.
 * The Web Share Target (manifest share_target.action) sends GET /share?title=&text=&url=
 * when the user shares content to within from another Android app.
 * This page combines the params into a pre-filled new entry draft.
 */
function ShareHandler() {
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    const title = searchParams.get("title") ?? undefined
    const text  = searchParams.get("text")  ?? undefined
    const url   = searchParams.get("url")   ?? undefined

    const draft = buildShareDraft({ title, text, url })

    // Navigate to the new-entry editor with the draft as a URL param so the
    // editor can pre-fill the text area. An empty draft still navigates to
    // the new-entry page so the user lands somewhere useful.
    const target = draft
      ? `/entry/new?draft=${encodeURIComponent(draft)}`
      : "/entry/new"

    router.replace(target)
  }, [searchParams, router])

  // Brief loading state while the redirect happens.
  return <Preparing />
}

function Preparing() {
  const { messages } = useI18n()
  return (
    <div className="h-dvh flex items-center justify-center text-muted-foreground text-sm">
      {messages.share.preparing}
    </div>
  )
}

export default function SharePage() {
  return (
    <Suspense fallback={<Preparing />}>
      <ShareHandler />
    </Suspense>
  )
}
