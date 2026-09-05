/**
 * within-mark render contract tests
 *
 * Verifies that the WithinMark component:
 *   - Exports a function named `WithinMark` (API unchanged)
 *   - Renders a filled glyph (fill="currentColor", no stroke) for the new nib design
 *   - Spreads extra props (className etc.) onto the SVG element
 *
 * Synthetic component tests only — no journal content.
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { WithinMark } from "../src/components/within-mark"

describe("WithinMark — nib brand mark", () => {
  it("exports a function named WithinMark", () => {
    expect(typeof WithinMark).toBe("function")
  })

  it("renders a filled glyph (fill=currentColor, no stroke)", () => {
    const html = renderToStaticMarkup(React.createElement(WithinMark))
    // New nib design uses fill="currentColor" / fillRule="evenodd"
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('fill-rule="evenodd"')
    // Old spiral used stroke — new nib must not
    expect(html).not.toContain("stroke-width")
    expect(html).not.toContain("strokeWidth")
  })

  it("is aria-hidden by default", () => {
    const html = renderToStaticMarkup(React.createElement(WithinMark))
    expect(html).toContain('aria-hidden="true"')
  })

  it("spreads extra props onto the SVG element", () => {
    const html = renderToStaticMarkup(
      React.createElement(WithinMark, { className: "size-4" })
    )
    expect(html).toContain('class="size-4"')
  })

  it("uses the 0 0 96 96 viewBox (nib coordinate space)", () => {
    const html = renderToStaticMarkup(React.createElement(WithinMark))
    expect(html).toContain('viewBox="0 0 96 96"')
  })
})
