"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { WithinMark } from "@/components/within-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useI18n } from "@/components/locale-provider"
import { apiErrorText, type ApiErrorBody } from "@/lib/i18n/api-errors"
import { isSafeInternalRedirect } from "@/lib/redirect-rules"

export default function LoginForm() {
  const router = useRouter()
  const { messages } = useI18n()
  const searchParams = useSearchParams()
  const rawFrom = searchParams.get("from") ?? "/"
  // Same-origin-relative only — der frühere startsWith-Check war per
  // Backslash umgehbar ("/\evil.example" → https://evil.example/).
  const from = isSafeInternalRedirect(rawFrom) ? rawFrom : "/"

  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [configError, setConfigError] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setConfigError(false)

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        router.push(from)
        router.refresh()
        return
      }

      const data = await res.json().catch(() => ({}))
      if (res.status === 500) {
        setConfigError(true)
      }
      setError(apiErrorText(messages, data as ApiErrorBody, messages.login.loginFailed))
    } catch {
      setError(messages.login.networkError)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm page-enter">
        {/* Logo + Titel */}
        <div className="text-center space-y-3 mb-6">
          <div className="flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
              <WithinMark className="h-7 w-7" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Within</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {messages.login.tagline}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">{messages.login.title}</CardTitle>
            <CardDescription>{messages.login.description}</CardDescription>
          </CardHeader>

          <CardContent>
            {/* Konfigurationsfehler */}
            {configError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 space-y-3 text-sm mb-4">
                <p className="font-medium text-destructive">{messages.login.configError.title}</p>
                <p className="text-muted-foreground">{error}</p>
                <div className="space-y-2 text-muted-foreground">
                  <p>{messages.login.configError.hashInstruction}</p>
                  <pre className="font-mono text-xs bg-muted px-3 py-2 rounded overflow-x-auto">
                    {messages.login.configError.hashCommand}
                  </pre>
                  <p className="text-xs">
                    {messages.login.configError.envPrefix}
                    <code className="bg-muted px-1 rounded">docker-compose.yml</code>
                    {messages.login.configError.envSuffix}
                  </p>
                  <pre className="font-mono text-xs bg-muted px-3 py-2 rounded overflow-x-auto">
                    docker compose up -d
                  </pre>
                </div>
              </div>
            )}

            {/* Login-Formular */}
            {!configError && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">{messages.login.passwordLabel}</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder={messages.login.passwordPlaceholder}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="current-password"
                    disabled={loading}
                    className="h-11"
                  />
                  {error && (
                    <p className="text-sm text-destructive">{error}</p>
                  )}
                </div>

                <Button
                  type="submit"
                  className="w-full h-11"
                  disabled={loading || !password}
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {messages.login.submitting}
                    </>
                  ) : (
                    messages.login.submit
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
