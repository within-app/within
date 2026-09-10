"use client"

import { ErrorFallback, resolveErrorLocale } from "@/components/error-fallback"
import "./globals.css"

/** Root-layout error boundary — replaces the layout, so it must render its
 *  own <html><body> (and load the stylesheet itself). */
export default function GlobalError() {
  return (
    <html lang={resolveErrorLocale()}>
      <body className="antialiased font-sans">
        <ErrorFallback />
      </body>
    </html>
  )
}
