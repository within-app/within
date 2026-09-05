import { describe, it, expect } from "vitest"
import {
  IDLE_MINUTES_DEFAULT,
  IDLE_MINUTES_KEY,
  readIdleMinutes,
  writeIdleMinutes,
} from "../src/lib/vault/lock-settings"

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe("lock-settings", () => {
  it("liefert den Default ohne gespeicherten Wert", () => {
    expect(readIdleMinutes(makeStorage())).toBe(IDLE_MINUTES_DEFAULT)
  })

  it("liest einen gültigen gespeicherten Wert", () => {
    expect(readIdleMinutes(makeStorage({ [IDLE_MINUTES_KEY]: "15" }))).toBe(15)
  })

  it("fällt bei ungültigen Werten auf den Default zurück", () => {
    expect(readIdleMinutes(makeStorage({ [IDLE_MINUTES_KEY]: "7" }))).toBe(IDLE_MINUTES_DEFAULT)
    expect(readIdleMinutes(makeStorage({ [IDLE_MINUTES_KEY]: "unsinn" }))).toBe(IDLE_MINUTES_DEFAULT)
    expect(readIdleMinutes(makeStorage({ [IDLE_MINUTES_KEY]: "0" }))).toBe(IDLE_MINUTES_DEFAULT)
  })

  it("write → read Roundtrip", () => {
    const storage = makeStorage()
    writeIdleMinutes(storage, 30)
    expect(readIdleMinutes(storage)).toBe(30)
  })

  it("kaputter Storage wirft nicht", () => {
    const broken = {
      getItem: () => { throw new Error("quota") },
      setItem: () => { throw new Error("quota") },
    }
    expect(readIdleMinutes(broken)).toBe(IDLE_MINUTES_DEFAULT)
    expect(() => writeIdleMinutes(broken, 5)).not.toThrow()
  })
})

describe("Auto-Lock-Aktivitätsereignisse (B11)", () => {
  // Bis B11 kannte der Idle-Timer nur touchstart/touchmove/keydown/pointerdown:
  // Am Desktop (seit 11.08. offizieller Zugriffsweg über :8443) zählte reines
  // Lesen mit Scrollrad/Mausbewegung NICHT als Aktivität — die App sperrte
  // nach 5 Minuten mitten im Lesen eines langen Eintrags.
  it("enthält Desktop-Aktivität (wheel, mousemove) zusätzlich zu Touch/Tastatur", async () => {
    const { AUTO_LOCK_ACTIVITY_EVENTS } = await import("../src/lib/vault/lock-settings")
    for (const ev of ["touchstart", "touchmove", "keydown", "pointerdown", "wheel", "mousemove"]) {
      expect(AUTO_LOCK_ACTIVITY_EVENTS).toContain(ev)
    }
  })
  it("use-vault-lock nutzt die kanonische Liste (kein Drift)", async () => {
    const { readFileSync } = await import("fs")
    const { join } = await import("path")
    const src = readFileSync(join(__dirname, "../src/hooks/use-vault-lock.ts"), "utf8")
    expect(src).toContain("AUTO_LOCK_ACTIVITY_EVENTS")
    expect(src).not.toMatch(/const activityEvents\s*=\s*\[/)
  })
})
