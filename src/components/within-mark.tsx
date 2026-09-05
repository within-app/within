import type { SVGProps } from "react"

/**
 * within brand mark — a fountain-pen nib that also reads as a keyhole
 * (writing × privacy). Filled glyph; place inside a coloured tile and the
 * fill inherits `currentColor` from the tile's `text-primary-foreground`.
 */
export function WithinMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 96 96"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      {...props}
    >
      <path d="M48 16 C38 17 30.5 25 29 40 C27.8 53 41 73 48 82 C55 73 68.2 53 67 40 C65.5 25 58 17 48 16 Z M52.8 40 a4.8 4.8 0 1 0 -9.6 0 a4.8 4.8 0 1 0 9.6 0 M46.8 46 L49.2 46 L48.6 78 L47.4 78 Z" />
    </svg>
  )
}
