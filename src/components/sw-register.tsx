'use client'
import { useEffect, useState } from 'react'
import { useI18n } from '@/components/locale-provider'
import { initMediaKeyChannel } from '@/lib/vault/media-key-channel'
import { wireSwUpdateTriggers } from '@/lib/sw-update-triggers'

export function SwRegister() {
  const { messages } = useI18n()
  const [waitingSW, setWaitingSW] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    // Vault P2: feed the media key to the SW (push on unlock/lock, answer
    // SW-restart pulls). Lives here with the rest of the SW lifecycle wiring.
    const cleanupMediaKeyChannel = initMediaKeyChannel()

    // Feldbefund 23.08.: register() prüft nur beim Seitenladen auf neue
    // SW-Bytes — ein über den Deploy hinweg offener Tab sah den Update-Prompt
    // nie und lief unbegrenzt auf alten Chunks. Zusätzliche Check-Anlässe
    // (Intervall, Tab sichtbar, online); Aktivierung bleibt hinter der
    // Nutzer-Bestätigung (SKIP_WAITING unten).
    let cleanupUpdateTriggers: (() => void) | undefined

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      cleanupUpdateTriggers = wireSwUpdateTriggers(
        () => reg.update(),
        { win: window, doc: document }
      )

      function trackInstalling(installing: ServiceWorker) {
        installing.addEventListener('statechange', () => {
          // New SW finished installing and is now waiting — offer the update prompt.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setWaitingSW(installing)
          }
        })
      }

      reg.addEventListener('updatefound', () => {
        if (reg.installing) trackInstalling(reg.installing)
      })

      // Handle the case where a SW is already waiting when this page loads.
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaitingSW(reg.waiting)
      }
    }).catch((err) => {
      console.error('[within] SW registration failed:', err)
    })

    // New SW took control — reload so this tab uses the fresh asset hashes.
    let refreshing = false
    const onControllerChange = () => {
      if (!refreshing) {
        refreshing = true
        window.location.reload()
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    return () => {
      cleanupMediaKeyChannel()
      cleanupUpdateTriggers?.()
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  if (!waitingSW) return null

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg"
    >
      <span>{messages.swUpdate.available}</span>
      <button
        className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        onClick={() => waitingSW.postMessage({ type: 'SKIP_WAITING' })}
      >
        {messages.swUpdate.reload}
      </button>
    </div>
  )
}
