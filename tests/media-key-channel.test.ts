/**
 * Vault P2 — Seiten-Hälfte des Schlüssel-Kanals zum Service Worker
 * (src/lib/vault/media-key-channel.ts).
 *
 * Der SW kann jederzeit sterben und neu starten (Schlüssel weg). Der Kanal
 * deckt beide Richtungen ab: Push bei jedem Vault-Statuswechsel
 * (unlock → MEDIA_KEY, lock → MEDIA_KEY_CLEAR) und Pull auf
 * MEDIA_KEY_REQUEST des SW — aber nur solange der Vault entsperrt ist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const vaultState: { dek: CryptoKey | null } = { dek: null }
const vaultListeners = new Set<() => void>()

vi.mock("@/lib/vault/vault", () => ({
  getSessionDek: () => vaultState.dek,
  subscribeVault: (fn: () => void) => {
    vaultListeners.add(fn)
    return () => vaultListeners.delete(fn)
  },
}))

import { initMediaKeyChannel } from "../src/lib/vault/media-key-channel"

function emitVault() {
  for (const fn of vaultListeners) fn()
}

interface FakeSw {
  controller: { postMessage: ReturnType<typeof vi.fn> } | null
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  startMessages: ReturnType<typeof vi.fn>
  emitMessage: (data: unknown) => void
}

function makeFakeSw(): FakeSw {
  const messageListeners = new Set<(event: { data: unknown }) => void>()
  return {
    controller: { postMessage: vi.fn() },
    addEventListener: vi.fn((type: string, fn: (event: { data: unknown }) => void) => {
      if (type === "message") messageListeners.add(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: (event: { data: unknown }) => void) => {
      if (type === "message") messageListeners.delete(fn)
    }),
    startMessages: vi.fn(),
    emitMessage: (data: unknown) => {
      for (const fn of messageListeners) fn({ data })
    },
  }
}

const FAKE_KEY = { fake: "crypto-key" } as unknown as CryptoKey

beforeEach(() => {
  vaultState.dek = null
  vaultListeners.clear()
})

describe("media-key-channel", () => {
  it("sendet den DEK an den SW, sobald der Vault entsperrt wird", () => {
    const sw = makeFakeSw()
    initMediaKeyChannel(sw as never)

    vaultState.dek = FAKE_KEY
    emitVault()

    expect(sw.controller!.postMessage).toHaveBeenCalledWith({ type: "MEDIA_KEY", key: FAKE_KEY })
  })

  it("sendet MEDIA_KEY_CLEAR, wenn der Vault sperrt", () => {
    const sw = makeFakeSw()
    vaultState.dek = FAKE_KEY
    initMediaKeyChannel(sw as never)
    sw.controller!.postMessage.mockClear()

    vaultState.dek = null
    emitVault()

    expect(sw.controller!.postMessage).toHaveBeenCalledWith({ type: "MEDIA_KEY_CLEAR" })
  })

  it("ruft startMessages() auf — ohne bleiben SW→Seite-Messages für immer in der Browser-Queue", () => {
    // Gerätetest-Befund 21.08.: Nach Offline-Neustart zeigte die App Platzhalter
    // statt Fotos. Die Spec queued Messages vom SW an die Seite, bis
    // startMessages() (oder .onmessage) die Zustellung startet —
    // addEventListener allein tut das NICHT. Damit war der Pull-Kanal
    // (MEDIA_KEY_REQUEST nach SW-Neustart) im echten Browser tot; der
    // Node-Harness stellt direkt zu und konnte das nicht abbilden.
    const sw = makeFakeSw()
    initMediaKeyChannel(sw as never)
    expect(sw.startMessages).toHaveBeenCalled()
  })

  it("beantwortet MEDIA_KEY_REQUEST nur im entsperrten Zustand", () => {
    const sw = makeFakeSw()
    initMediaKeyChannel(sw as never)
    sw.controller!.postMessage.mockClear()

    // gesperrt → keine Antwort (der SW zeigt dann Platzhalter)
    sw.emitMessage({ type: "MEDIA_KEY_REQUEST" })
    expect(sw.controller!.postMessage).not.toHaveBeenCalled()

    vaultState.dek = FAKE_KEY
    sw.emitMessage({ type: "MEDIA_KEY_REQUEST" })
    expect(sw.controller!.postMessage).toHaveBeenCalledWith({ type: "MEDIA_KEY", key: FAKE_KEY })
  })

  it("sendet beim Init sofort, wenn schon entsperrt (SW-Update während laufender Session)", () => {
    const sw = makeFakeSw()
    vaultState.dek = FAKE_KEY
    initMediaKeyChannel(sw as never)
    expect(sw.controller!.postMessage).toHaveBeenCalledWith({ type: "MEDIA_KEY", key: FAKE_KEY })
  })

  it("übersteht einen fehlenden Controller (Erstinstallation) ohne Fehler", () => {
    const sw = makeFakeSw()
    sw.controller = null
    initMediaKeyChannel(sw as never)
    vaultState.dek = FAKE_KEY
    expect(() => emitVault()).not.toThrow()
    expect(() => sw.emitMessage({ type: "MEDIA_KEY_REQUEST" })).not.toThrow()
  })

  it("cleanup meldet Listener und Vault-Subscription ab", () => {
    const sw = makeFakeSw()
    const cleanup = initMediaKeyChannel(sw as never)
    cleanup()
    expect(vaultListeners.size).toBe(0)
    expect(sw.removeEventListener).toHaveBeenCalled()

    sw.controller!.postMessage.mockClear()
    vaultState.dek = FAKE_KEY
    sw.emitMessage({ type: "MEDIA_KEY_REQUEST" })
    expect(sw.controller!.postMessage).not.toHaveBeenCalled()
  })
})
