"use client"

import { useEffect, useRef } from "react"

export interface HotkeyBinding {
  key: string
  cmdOrCtrl?: boolean
  handler: (e: KeyboardEvent) => void
}

/** Returns true when the element is a form control or contenteditable — hotkeys are suppressed here. */
export function isFocusedInForm(el: Element | null): boolean {
  if (!el) return false
  const tag = (el as HTMLElement).tagName.toLowerCase()
  return tag === "input" || tag === "textarea" || tag === "select" || (el as HTMLElement).isContentEditable
}

/** Returns true when the keyboard event matches the binding descriptor. */
export function matchesBinding(
  binding: Omit<HotkeyBinding, "handler">,
  e: { key: string; metaKey: boolean; ctrlKey: boolean }
): boolean {
  const hasCmdCtrl = e.metaKey || e.ctrlKey
  if (binding.cmdOrCtrl && !hasCmdCtrl) return false
  if (!binding.cmdOrCtrl && hasCmdCtrl) return false
  return e.key === binding.key
}

/**
 * Registers global keydown listeners for the given bindings.
 * Events are ignored when focus is inside an input, textarea, select, or contenteditable.
 * Bindings array is captured in a ref so callers can pass inline arrays without
 * triggering effect re-runs.
 */
export function useHotkeys(bindings: HotkeyBinding[]): void {
  const ref = useRef<HotkeyBinding[]>([])

  useEffect(() => {
    ref.current = bindings
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isFocusedInForm(document.activeElement)) return
      for (const b of ref.current) {
        if (matchesBinding(b, e)) {
          b.handler(e)
          return
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
