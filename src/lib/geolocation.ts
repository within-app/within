/**
 * Core geolocation logic (browser Geolocation API, secure context only).
 * Exported for unit testing; the hook (src/hooks/use-geolocation.ts) calls these.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type GeoErrorKind = 'denied' | 'timeout' | 'unavailable';

export class GeoError extends Error {
  kind: GeoErrorKind;

  constructor(kind: GeoErrorKind) {
    super(kind);
    this.name = 'GeoError';
    this.kind = kind;
  }
}

// Zweistufige Ortung: erst präziser GPS-Fix, bei Timeout/Nichtverfügbarkeit
// (typisch in Innenräumen) der schnelle Netzwerk-Fix über WLAN/Funkzellen.
const HIGH_ACCURACY_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
};

const NETWORK_FALLBACK_OPTIONS = {
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 300000,
};

/** True if the browser Geolocation API can work here (API present + secure context). */
export function isWebGeolocationAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'geolocation' in navigator &&
    typeof window !== 'undefined' &&
    window.isSecureContext === true
  );
}

/** True if a position can be requested here (async to keep the hook's call shape). */
export async function isGeolocationAvailable(): Promise<boolean> {
  return isWebGeolocationAvailable();
}

/** Web path: browser Geolocation API (secure context only). */
export async function getWebPosition(): Promise<GeoPoint> {
  try {
    return await webPositionOnce(HIGH_ACCURACY_OPTIONS);
  } catch (err) {
    if (mapGeoError(err) === 'denied') throw err;
    return webPositionOnce(NETWORK_FALLBACK_OPTIONS);
  }
}

function webPositionOnce(options: PositionOptions): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      options,
    );
  });
}

/** Maps browser geolocation errors to a stable kind for the UI messages. */
export function mapGeoError(err: unknown): GeoErrorKind {
  if (err instanceof GeoError) return err.kind;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('denied')) return 'denied';
    if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  }
  return 'unavailable';
}

/** 5 decimal places ≈ 1,1 m — more is GPS noise, less loses house-level accuracy. */
export function formatCoord(value: number): string {
  return value.toFixed(5);
}
