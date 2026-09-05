import { randomBytes } from "crypto"

/**
 * Generates a cryptographically random nonce for use in Content-Security-Policy.
 * Uses base64url encoding (URL-safe, no padding).
 */
export function generateNonce(): string {
  return randomBytes(16).toString("base64url")
}

/**
 * Builds a Content-Security-Policy header value with a per-request nonce.
 *
 * script-src uses 'nonce-<value>' instead of 'unsafe-inline'.
 * style-src retains 'unsafe-inline' — required by Tailwind/shadcn CSS variables.
 */
export function buildCspWithNonce(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // MapLibre creates its web worker from a same-origin URL (public/map/) —
    // no blob:, no unsafe-eval needed.
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}
