import { defineConfig } from "vitest/config"
import { resolve } from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Prebundles these barrels once instead of re-resolving every submodule
    // on each SSR-probe import.
    deps: { optimizer: { ssr: { enabled: true, include: ["date-fns", "date-fns/locale", "react-day-picker"] } } },
  },
})
