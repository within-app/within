import { headers } from "next/headers"

/**
 * Reads the per-request CSP nonce forwarded by the middleware via x-nonce.
 * Returns an empty string when the header is absent (e.g. in static/test contexts).
 *
 * Must be called from a Server Component that is rendered dynamically
 * (layout.tsx must export `dynamic = 'force-dynamic'`).
 */
export async function getNonce(): Promise<string> {
  const h = await headers()
  return h.get("x-nonce") ?? ""
}
