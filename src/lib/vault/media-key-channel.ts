/**
 * Vault P2 (Sicherheitskonzept Offline-Daten §5.4) — Schlüssel-Kanal
 * Seite ↔ Service Worker für den verschlüsselten Medien-Cache.
 *
 * Push: Bei jedem Vault-Statuswechsel geht der Session-DEK (non-extractable
 * CryptoKey, structured clone) an den kontrollierenden SW — Entsperren
 * sendet MEDIA_KEY, Sperren MEDIA_KEY_CLEAR (Lock = Schlüssel weg, auch im
 * SW-Speicher).
 *
 * Pull: Der SW stirbt nach Sekunden Idle und startet ohne Schlüssel neu.
 * Er fragt dann per MEDIA_KEY_REQUEST; die Seite antwortet nur im
 * entsperrten Zustand — gesperrt bleibt die Anfrage unbeantwortet und der
 * SW liefert Platzhalter (nie einen Fehler).
 *
 * Browser-only. Initialisiert in sw-register.tsx.
 */
"use client"

import { getSessionDek, subscribeVault } from "@/lib/vault/vault"

interface MediaKeyChannelTarget {
  controller: Pick<ServiceWorker, "postMessage"> | null
  addEventListener: (type: "message", fn: (event: MessageEvent) => void) => void
  removeEventListener: (type: "message", fn: (event: MessageEvent) => void) => void
  startMessages: () => void
}

export function initMediaKeyChannel(
  sw: MediaKeyChannelTarget = navigator.serviceWorker
): () => void {
  const push = () => {
    const target = sw.controller
    if (!target) return
    const key = getSessionDek()
    if (key) target.postMessage({ type: "MEDIA_KEY", key })
    else target.postMessage({ type: "MEDIA_KEY_CLEAR" })
  }

  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type !== "MEDIA_KEY_REQUEST") return
    const key = getSessionDek()
    if (key) sw.controller?.postMessage({ type: "MEDIA_KEY", key })
  }

  const unsubscribe = subscribeVault(push)
  sw.addEventListener("message", onMessage)
  // KRITISCH (Gerätetest-Befund 21.08.): Der Browser queued SW→Seite-Messages,
  // bis startMessages() die Zustellung startet — addEventListener allein tut
  // das nicht (nur das Setzen von .onmessage würde es implizit tun). Ohne
  // diesen Aufruf erreicht MEDIA_KEY_REQUEST die Seite nie und der Pull-Kanal
  // nach einem SW-Neustart ist tot: offline hieße das dauerhaft Platzhalter
  // statt Fotos, obwohl die App entsperrt ist.
  sw.startMessages()
  // Sofort-Push deckt den Fall ab, dass der Vault beim Init schon entsperrt
  // ist (SW-Update oder Remount während laufender Session).
  push()

  return () => {
    unsubscribe()
    sw.removeEventListener("message", onMessage)
  }
}
