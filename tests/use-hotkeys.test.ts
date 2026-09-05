/**
 * use-hotkeys — pure logic unit tests
 *
 * Tests the pure-logic helpers extracted from the hook:
 *  - isFocusedInForm(el): true when focused element is a form control/contenteditable
 *  - matchesBinding(binding, event): true when a KeyboardEvent matches a HotkeyBinding
 *
 * DOM integration (addEventListener) is not covered here because vitest runs in
 * node environment; functional correctness is verified by Playwright E2E.
 */

import { describe, it, expect } from "vitest"
import { isFocusedInForm, matchesBinding } from "../src/hooks/use-hotkeys"

// ---------------------------------------------------------------------------
// isFocusedInForm
// ---------------------------------------------------------------------------
describe("isFocusedInForm", () => {
  it("returns false for null", () => {
    expect(isFocusedInForm(null)).toBe(false)
  })

  it("returns true for <input>", () => {
    expect(isFocusedInForm({ tagName: "INPUT", isContentEditable: false } as unknown as Element)).toBe(true)
  })

  it("returns true for <textarea>", () => {
    expect(isFocusedInForm({ tagName: "TEXTAREA", isContentEditable: false } as unknown as Element)).toBe(true)
  })

  it("returns true for <select>", () => {
    expect(isFocusedInForm({ tagName: "SELECT", isContentEditable: false } as unknown as Element)).toBe(true)
  })

  it("returns true for contenteditable element", () => {
    expect(isFocusedInForm({ tagName: "DIV", isContentEditable: true } as unknown as Element)).toBe(true)
  })

  it("returns false for regular <div>", () => {
    expect(isFocusedInForm({ tagName: "DIV", isContentEditable: false } as unknown as Element)).toBe(false)
  })

  it("returns false for <button>", () => {
    expect(isFocusedInForm({ tagName: "BUTTON", isContentEditable: false } as unknown as Element)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchesBinding
// ---------------------------------------------------------------------------
type FakeEvent = { key: string; metaKey: boolean; ctrlKey: boolean }

describe("matchesBinding", () => {
  // Cmd+N
  it("matches Cmd+N (metaKey)", () => {
    const e: FakeEvent = { key: "n", metaKey: true, ctrlKey: false }
    expect(matchesBinding({ key: "n", cmdOrCtrl: true }, e)).toBe(true)
  })

  it("matches Cmd+N (ctrlKey)", () => {
    const e: FakeEvent = { key: "n", metaKey: false, ctrlKey: true }
    expect(matchesBinding({ key: "n", cmdOrCtrl: true }, e)).toBe(true)
  })

  it("does not match plain n for Cmd+N binding", () => {
    const e: FakeEvent = { key: "n", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "n", cmdOrCtrl: true }, e)).toBe(false)
  })

  // Escape
  it("matches plain Escape", () => {
    const e: FakeEvent = { key: "Escape", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "Escape" }, e)).toBe(true)
  })

  it("does not match Escape when Meta held (Cmd+Escape is a system shortcut)", () => {
    const e: FakeEvent = { key: "Escape", metaKey: true, ctrlKey: false }
    expect(matchesBinding({ key: "Escape" }, e)).toBe(false)
  })

  // j/k navigation — no modifiers
  it("matches plain j for vim-next", () => {
    const e: FakeEvent = { key: "j", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "j" }, e)).toBe(true)
  })

  it("does not match Cmd+j for plain-j binding (avoid conflict with Cmd+K palette)", () => {
    const e: FakeEvent = { key: "j", metaKey: true, ctrlKey: false }
    expect(matchesBinding({ key: "j" }, e)).toBe(false)
  })

  // ArrowUp / ArrowDown
  it("matches ArrowDown", () => {
    const e: FakeEvent = { key: "ArrowDown", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "ArrowDown" }, e)).toBe(true)
  })

  it("does not match wrong key", () => {
    const e: FakeEvent = { key: "ArrowUp", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "ArrowDown" }, e)).toBe(false)
  })

  // Cmd+K
  it("matches Cmd+K (for palette)", () => {
    const e: FakeEvent = { key: "k", metaKey: true, ctrlKey: false }
    expect(matchesBinding({ key: "k", cmdOrCtrl: true }, e)).toBe(true)
  })

  it("plain k does not match Cmd+K binding", () => {
    const e: FakeEvent = { key: "k", metaKey: false, ctrlKey: false }
    expect(matchesBinding({ key: "k", cmdOrCtrl: true }, e)).toBe(false)
  })
})
