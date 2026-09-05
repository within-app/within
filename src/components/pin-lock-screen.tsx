"use client"

import { useState } from "react"
import { Loader2, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { useI18n } from "@/components/locale-provider"

interface PinLockScreenProps {
  onUnlock: (pin: string) => Promise<boolean>
  onReset: () => Promise<void>
}

/**
 * Full-screen PIN gate shown while the vault is locked (Sicherheitskonzept
 * Offline-Daten, P1). Overlay pattern: FocusScope
 * keeps keyboard focus inside, the provider marks the app content inert.
 */
export function PinLockScreen({ onUnlock, onReset }: PinLockScreenProps) {
  const { messages } = useI18n()
  const [pin, setPin] = useState("")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const ok = await onUnlock(pin)
      if (!ok) {
        setFailed(true)
        setPin("")
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    setResetting(true)
    try {
      await onReset()
    } finally {
      setResetting(false)
    }
  }

  return (
    <FocusScope loop trapped asChild>
      <div
        className="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-8 bg-background p-4"
        aria-modal="true"
        role="dialog"
        aria-label={messages.lock.dialogLabel}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-[22px] bg-primary/10">
            <Lock className="h-10 w-10 text-primary" aria-hidden />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">within</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {failed ? messages.lock.wrongPin : messages.lock.enterPin}
            </p>
          </div>
        </div>

        {confirmingReset ? (
          <div className="w-full max-w-sm space-y-4">
            <p className="text-sm text-muted-foreground">{messages.lock.resetWarning}</p>
            <div className="flex flex-col gap-2">
              <Button
                variant="destructive"
                className="h-11 w-full"
                onClick={handleReset}
                disabled={resetting}
              >
                {resetting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {messages.lock.resetting}
                  </>
                ) : (
                  messages.lock.resetConfirm
                )}
              </Button>
              <Button
                variant="ghost"
                className="h-11 w-full"
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
              >
                {messages.lock.resetCancel}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
            <Input
              type="password"
              inputMode="text"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              aria-label={messages.lock.pinLabel}
              autoFocus
              autoComplete="off"
              disabled={busy}
              className="h-11 text-center"
            />
            <Button type="submit" className="h-11 w-full" disabled={busy || !pin}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {messages.lock.unlocking}
                </>
              ) : (
                messages.lock.unlock
              )}
            </Button>
            <button
              type="button"
              className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setConfirmingReset(true)}
              disabled={busy}
            >
              {messages.lock.forgotPin}
            </button>
          </form>
        )}
      </div>
    </FocusScope>
  )
}
