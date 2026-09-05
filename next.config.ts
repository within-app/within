import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
// Gate HSTS on a real trusted proxy (Caddy on the Pi sets TRUSTED_PROXY_COUNT=1).
// NODE_ENV=production alone fires in staging too — which has no TLS at the load-balancer.
const hasTrustedProxy = parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10) > 0;

// CSP is set per-request by the middleware (src/proxy.ts) using a per-request
// nonce — script-src uses 'nonce-<value>' instead of 'unsafe-inline'.
// No static CSP header here: a static 'unsafe-inline' would weaken the nonce-based
// policy and create ambiguity for security audits.
const securityHeaders = [
  // Clickjacking-Schutz (für Browser ohne CSP frame-ancestors Support)
  { key: "X-Frame-Options", value: "DENY" },
  // Verhindert MIME-Type-Sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Kein Referrer an externe Seiten
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deaktiviert Browser-Features die die App nicht benötigt.
  // geolocation=(self): eigene Origin darf GPS-Koordinaten für Einträge abfragen (Standort-Button im Editor)
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
  // HSTS: only when real TLS is in play (Pi/Caddy sets TRUSTED_PROXY_COUNT=1; staging does not)
  ...(isProd && hasTrustedProxy
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone", // Required for Docker deployment
  // Next 16's `agentRules` feature can auto-append AI assistant instructions to
  // project docs on `next dev` startup — keep it disabled; our docs are hand-maintained.
  agentRules: false,
  experimental: {
    // Raise the standalone proxy body limit to match maxRequestBodySize so that
    // oversized ZIPs reach the route's streaming guard (which returns 413).
    // MAX_IMPORT_COMPRESSED = 100 * 1024 * 1024 = 104,857,600 bytes (guard threshold).
    // maxRequestBodySize   = "105mb" = 105 * 1024 * 1024 = 110,100,480 bytes (route limit).
    // proxyClientMaxBodySize must be >= maxRequestBodySize; otherwise bodies between
    // 105_000_000 and 110,100,480 bytes (like a 102 MiB ZIP) are truncated by the
    // proxy before reaching the handler — producing a fflate parse error (422) instead
    // of the expected 413.
    proxyClientMaxBodySize: 105 * 1024 * 1024, // 105 MiB — matches maxRequestBodySize
  },
  serverExternalPackages: ["sharp"],
  async headers() {
    return [
      {
        // Alle Routen
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        // HTTP-Cache-Leck: Medien liegen unter public/media — je nach
        // Server-Generation bedient Nexts STATISCHE public/-Auslieferung den
        // Request (mit eigenem `public, max-age=0` + ETag) und der
        // Route-Handler läuft nie. Journal-Inhalt darf den Browser-HTTP-Cache
        // in KEINER Auslieferungs-Variante erreichen — deshalb zentral hier,
        // zusätzlich zur Route.
        source: "/media/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        // Service worker: must never be cached by the browser (browser checks for
        // updates on each page load; a stale cached SW breaks offline updates).
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript" },
        ],
      },
      {
        // PWA manifest: short cache, correct MIME type required by Chrome for install.
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
