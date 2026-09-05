/**
 * Optionales Verkleinern großer Fotos VOR dem Upload — Geräte-Einstellung.
 *
 * Hintergrund: Auf speicherschwachen/gehärteten Mobil-Browsern
 * (GrapheneOS/Vanadium) crasht der Tab reproduzierbar beim Upload-Handling
 * ~10-MB-Fotos, während dieselbe Datei auf dem Desktop problemlos läuft.
 * Der Schalter ist deshalb bewusst PRO GERÄT (localStorage, wie das Theme)
 * und standardmäßig AUS — Desktop-Uploads bleiben byte-identisch Original.
 *
 * Der Verkleinerungspfad ist durchgehend speicherschonend: Dimensionen kommen
 * aus dem Header-Parse (<img> naturalWidth), die Pixel aus einem subsampled
 * Decode (createImageBitmap resizeWidth/Height) — die Full-Res-Pixel des
 * Originals werden nie materialisiert.
 */

export const DOWNSCALE_STORAGE_KEY = "within.uploadDownscale"
/** Längste Kante nach Verkleinerung. */
export const DOWNSCALE_MAX_EDGE = 4096
/** Ab dieser Dateigröße wird (bei aktivem Schalter) immer verkleinert. */
export const DOWNSCALE_MIN_BYTES = 6 * 1024 * 1024
/**
 * Fail-closed-Kappe: Wenn der Schalter AN ist und ein
 * Foto trotz Verkleinerungsversuch über dieser Grenze bleibt, wird es sichtbar
 * abgelehnt statt als Original hochgeladen/gequeued — der stille Original-
 * Fallback hat auf Vanadium genau die 11-MB-Zombies erzeugt, die der Schalter
 * verhindern sollte.
 */
export const UPLOAD_HARD_CAP_BYTES = 8 * 1024 * 1024
const JPEG_QUALITY = 0.85

export function isDownscaleEnabled(store: Pick<Storage, "getItem">): boolean {
  try {
    return store.getItem(DOWNSCALE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export function setDownscaleEnabled(
  store: Pick<Storage, "setItem" | "removeItem">,
  enabled: boolean
): void {
  if (enabled) store.setItem(DOWNSCALE_STORAGE_KEY, "1")
  else store.removeItem(DOWNSCALE_STORAGE_KEY)
}

/** Verkleinern nötig? Nur Fotos, und nur wenn Datei ODER Kantenlänge groß sind. */
export function needsDownscale(opts: {
  mimeType: string
  size: number
  width: number
  height: number
  maxEdge?: number
  minBytes?: number
}): boolean {
  const maxEdge = opts.maxEdge ?? DOWNSCALE_MAX_EDGE
  const minBytes = opts.minBytes ?? DOWNSCALE_MIN_BYTES
  if (!opts.mimeType.startsWith("image/")) return false
  return opts.size > minBytes || Math.max(opts.width, opts.height) > maxEdge
}

/** Zielmaße: längste Kante auf maxEdge, Seitenverhältnis erhalten, nie hochskalieren. */
export function computeTarget(
  width: number,
  height: number,
  maxEdge: number = DOWNSCALE_MAX_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Bildmaße aus dem Header — <img> parst Dimensionen ohne vollen Pixel-Decode. */
function readImageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof URL === "undefined" || typeof Image === "undefined") return resolve(null)
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

export type DownscaleResult =
  | { ok: true; blob: Blob; changed: boolean }
  | { ok: false }

/**
 * Versucht, ein Foto auf maxEdge zu verkleinern (JPEG, Qualität 0.85).
 * Ehrliches Ergebnis statt stillem Fallback: `{ok: false}` bei jedem Fehler
 * oder fehlender Plattform-API — der Aufrufer entscheidet fail-closed, ob das
 * Original trotzdem zulässig ist (kleine Datei) oder sichtbar abgelehnt wird.
 */
export async function tryDownscalePhoto(
  blob: Blob,
  maxEdge: number = DOWNSCALE_MAX_EDGE
): Promise<DownscaleResult> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return { ok: false }
    const size = await readImageSize(blob)
    if (!size || size.width <= 0) return { ok: false }
    if (!needsDownscale({ mimeType: blob.type, size: blob.size, ...size, maxEdge })) {
      return { ok: true, blob, changed: false }
    }

    const target = computeTarget(size.width, size.height, maxEdge)
    let bitmap: ImageBitmap | null = null
    try {
      // Subsampled Decode — Full-Res-Pixel werden nie materialisiert.
      try {
        bitmap = await createImageBitmap(blob, {
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: "high",
        })
      } catch {
        // Resize-Optionen nicht unterstützt — voller Decode als zweiter Versuch.
        bitmap = await createImageBitmap(blob)
      }
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext("2d")
      if (!ctx) return { ok: false }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const out = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
      )
      if (!out || out.size === 0) return { ok: false }
      return { ok: true, blob: out, changed: true }
    } finally {
      bitmap?.close()
    }
  } catch (err) {
    console.error("[within/upload] Verkleinern fehlgeschlagen:", err)
    return { ok: false }
  }
}

/** Dateiname fürs re-encodierte JPEG. */
export function jpegName(originalName: string): string {
  return originalName.replace(/\.[^.]+$/, "") + ".jpg"
}
