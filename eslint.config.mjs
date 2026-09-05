import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Downgrade rules that flag pre-existing patterns introduced before this ESLint
// config existed (Next.js 16 / eslint-plugin-react-hooks v5 brought new rules).
// Fix incrementally in a follow-up (lint cleanup).
const preExistingPatternOverrides = {
  rules: {
    "react-hooks/set-state-in-effect": "warn",
    "react-hooks/purity": "warn",
    "react-hooks/refs": "warn",
    // tailwind.config.ts uses require() for the tailwindcss/nesting plugin
    "@typescript-eslint/no-require-imports": "warn",
  },
};

// Client-seitiger Code erzeugt IDs über safeUUID(): crypto.randomUUID
// fehlt in unsicheren Kontexten (http-Origin) und wirft NotSupportedError — der
// Offline-Pfad muss dort trotzdem speichern können. Server-Code (src/app/api,
// src/lib/db) darf die native API nutzen.
const safeUuidOnClient = {
  files: ["src/components/**", "src/hooks/**", "src/lib/sync/**", "src/lib/offline/**"],
  ignores: ["src/lib/sync/queue-edit.ts"],
  rules: {
    "no-restricted-properties": [
      "error",
      { object: "crypto", property: "randomUUID", message: "Use safeUUID() from @/lib/sync/queue-edit (no secure context on http origins)." },
    ],
  },
};

const eslintConfig = [
  // Ignore git worktree directories — they contain their own .next/ build
  // artifacts and node_modules that eslint should never scan. public/map/
  // holds the vendored MapLibre worker pair (copied from node_modules by
  // scripts/copy-map-worker.mjs) — generated code, not ours to lint.
  { ignores: [".worktrees/**", "public/map/**"] },
  ...coreWebVitals,
  ...nextTypescript,
  preExistingPatternOverrides,
  safeUuidOnClient,
];

export default eslintConfig;
