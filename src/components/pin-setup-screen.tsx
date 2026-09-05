"use client"

import { useState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { useI18n } from "@/components/locale-provider"
import { MIN_PIN_LENGTH } from "@/lib/vault/vault"

interface PinSetupScreenProps {
  onSetup: (pin: string) => Promise<void>
}

/**
 * One-time vault setup (Sicherheitskonzept Offline-Daten, P1): forced before
 * any app content on a device without a vault — this is also the migration
 * trigger that encrypts pre-existing plaintext stores.
 */
export function PinSetupScreen({ onSetup }: PinSetupScreenProps) {
  const { messages } = useI18n()
  const [pin, setPin] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (pin.length < MIN_PIN_LENGTH) {
      setError(messages.lock.pinTooShort(MIN_PIN_LENGTH))
      return
    }
    if (pin !== confirm) {
      setError(messages.lock.pinMismatch)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSetup(pin)
    } catch (err) {
      setError(err instanceof Error ? err.message : messages.common.unknownError)
      setBusy(false)
    }
  }

  return (
    <FocusScope loop trapped asChild>
      <div
        className="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-8 overflow-y-auto bg-background p-4"
        aria-modal="true"
        role="dialog"
        aria-label={messages.lock.setupTitle}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-[22px] bg-primary/10">
            <ShieldCheck className="h-10 w-10 text-primary" aria-hidden />
          </div>
          <div className="max-w-sm text-center">
            <h1 className="text-2xl font-bold tracking-tight">{messages.lock.setupTitle}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{messages.lock.setupIntro}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vault-pin">{messages.lock.pinLabel}</Label>
            <Input
              id="vault-pin"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
              autoComplete="new-password"
              disabled={busy}
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">{messages.lock.setupHint}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vault-pin-confirm">{messages.lock.pinConfirmLabel}</Label>
            <Input
              id="vault-pin-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
              className="h-11"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="h-11 w-full" disabled={busy || !pin || !confirm}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {messages.lock.settingUp}
              </>
            ) : (
              messages.lock.setupSubmit
            )}
          </Button>
        </form>
      </div>
    </FocusScope>
  )
}
