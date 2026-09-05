/**
 * Nebenbefunde (UI-Anteil) — Source-Guards, weil das Repo keinen
 * React-Render-Runner (RTL) hat:
 *  - photo-uploader zieht MIME-Allowlists und Größenlimits aus
 *    upload-security statt eigener Kopien (Client/Server-Drift).
 *  - command-palette und photo-gallery geben ihrem DialogContent einen
 *    DialogTitle (Radix a11y: Dialog ohne Titel = Warnung + kein Name).
 *  - entry/[id]/page.tsx hat keinen hartkodierten „Zurück“-Text mehr.
 * Synthetic only.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("photo-uploader teilt Limits mit upload-security", () => {
  const src = read("src/components/editor/photo-uploader.tsx")
  it("importiert Allowlists + getMaxMBForType aus @/lib/upload-security", () => {
    expect(src).toMatch(/from "@\/lib\/upload-security"/)
    expect(src).toMatch(/getMaxMBForType/)
  })
  it("hat keine eigene MAX_BYTES-Tabelle und keine eigene Video-/Audio-Allowlist", () => {
    expect(src).not.toMatch(/const MAX_BYTES/)
    expect(src).not.toMatch(/const ALLOWED_VIDEO_MIMES\s*=/)
    expect(src).not.toMatch(/const ALLOWED_AUDIO_MIMES\s*=/)
  })
})

describe("DialogContent trägt einen DialogTitle", () => {
  for (const f of ["src/components/command-palette.tsx", "src/components/detail/photo-gallery.tsx"]) {
    it(f, () => {
      const src = read(f)
      expect(src).toMatch(/<DialogTitle\b/)
    })
  }
})

describe("entry/[id]/page.tsx ist i18n-sauber", () => {
  it("kein hartkodiertes „Zurück“", () => {
    expect(read("src/app/entry/[id]/page.tsx")).not.toMatch(/>\s*Zurück\s*</)
  })
})
