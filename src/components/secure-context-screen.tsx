"use client"

import { ShieldAlert } from "lucide-react"
import { useI18n } from "@/components/locale-provider"

/**
 * Vault P2: full-screen notice shown instead of the vault gate when the page
 * runs outside a secure context (plain HTTP). WebCrypto — and with it PIN
 * setup and unlock — only exists on HTTPS; without this screen the setup
 * would die with a cryptic `crypto.subtle` TypeError.
 */
export function SecureContextScreen() {
  const { messages } = useI18n()
  return (
    <div
      className="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-4 bg-background p-6 text-center"
      role="alert"
    >
      <ShieldAlert className="h-10 w-10 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold">{messages.lock.insecureTitle}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{messages.lock.insecureBody}</p>
    </div>
  )
}
