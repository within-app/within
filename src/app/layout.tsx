import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import { cookies } from "next/headers"
import { ThemeProvider } from "next-themes"
import { SwRegister } from "@/components/sw-register"
import { AppLockProvider } from "@/components/app-lock-provider"
import { SyncProvider } from "@/components/sync/sync-provider"
import { LocaleProvider } from "@/components/locale-provider"
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from "@/lib/i18n/config"
import { getMessages } from "@/lib/i18n"
import { getNonce } from "@/lib/nonce"
import { getAppTimeZone } from "@/lib/timezone"
import "./globals.css"

// Lora — self-hosted, no CDN call, works fully offline on Pi
const lora = localFont({
  src: [
    { path: "../../public/fonts/lora/lora-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/lora/lora-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../../public/fonts/lora/lora-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/lora/lora-latin-500-italic.woff2", weight: "500", style: "italic" },
    { path: "../../public/fonts/lora/lora-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/lora/lora-latin-600-italic.woff2", weight: "600", style: "italic" },
  ],
  variable: "--font-serif",
  display: "swap",
})

// Beschreibung folgt der UI-Sprache aus dem Cookie (force-dynamic ist gesetzt).
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(LOCALE_COOKIE)?.value
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE
  return {
    title: "within",
    description: getMessages(locale).login.tagline,
    manifest: "/manifest.webmanifest",
    icons: {
      icon: "/icon.svg",
      apple: "/apple-touch-icon.png",
    },
    appleWebApp: {
      capable: true,
      title: "within",
      statusBarStyle: "black-translucent",
    },
  }
}

export const viewport: Viewport = {
  themeColor: "#0A84FF",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

// Force dynamic rendering so the per-request x-nonce from middleware is
// always available — prevents PPR from caching a nonce-less static shell.
export const dynamic = "force-dynamic"

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const nonce = await getNonce()
  // UI-Sprache aus dem Request-Cookie — SSR und Client starten konsistent.
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE

  return (
    <html lang={locale} suppressHydrationWarning className={`h-full ${lora.variable}`}>
      <body className="antialiased font-sans h-full overflow-hidden">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="within-theme"
          nonce={nonce}
        >
          <LocaleProvider initialLocale={locale} timeZone={getAppTimeZone()}>
            <AppLockProvider>
              <SyncProvider>
                {children}
              </SyncProvider>
            </AppLockProvider>
          </LocaleProvider>
        </ThemeProvider>
        <SwRegister />
      </body>
    </html>
  )
}
