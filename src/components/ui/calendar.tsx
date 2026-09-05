"use client"

import * as React from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
import {
  DayButton,
  DayPicker,
  getDefaultClassNames,
  type ChevronProps,
  type RootProps,
} from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"

// Module-level component defs: an inline definition inside DayPicker's
// components={{ ... }} prop creates a new element type every render, which
// remounts the whole DayPicker subtree.
function CalendarRoot({ className, rootRef, ...props }: RootProps) {
  return (
    <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
  )
}

function CalendarChevron({ className, orientation, ...props }: ChevronProps) {
  if (orientation === "left") {
    return <ChevronLeftIcon className={cn("size-4", className)} {...props} />
  }

  if (orientation === "right") {
    return <ChevronRightIcon className={cn("size-4", className)} {...props} />
  }

  return <ChevronDownIcon className={cn("size-4", className)} {...props} />
}

// getDefaultClassNames() just builds a static rdp-* class-name map (no
// per-render input) — computed once at module load, used by both Calendar
// and CalendarDayButton below.
const DEFAULT_CLASSNAMES = getDefaultClassNames()

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
}) {
  // DayPicker memoizes components/formatters/classNames internally on these
  // exact prop identities (its own useMemo deps) — passing fresh object
  // literals on every render defeats that memo and forces DayPicker to redo
  // the work (getComponents/getFormatters/classNames-merge) on every parent
  // re-render, not just when these props actually change.
  const merged = React.useMemo(
    () => ({
      classNames: {
        root: cn("w-fit", DEFAULT_CLASSNAMES.root),
        months: cn(
          "relative flex flex-col gap-4 md:flex-row",
          DEFAULT_CLASSNAMES.months
        ),
        month: cn("flex w-full flex-col gap-4", DEFAULT_CLASSNAMES.month),
        nav: cn(
          "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
          DEFAULT_CLASSNAMES.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          DEFAULT_CLASSNAMES.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          DEFAULT_CLASSNAMES.button_next
        ),
        month_caption: cn(
          "flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]",
          DEFAULT_CLASSNAMES.month_caption
        ),
        dropdowns: cn(
          "flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium",
          DEFAULT_CLASSNAMES.dropdowns
        ),
        dropdown_root: cn(
          "has-focus:border-ring border-input shadow-xs has-focus:ring-ring/50 has-focus:ring-[3px] relative rounded-md border",
          DEFAULT_CLASSNAMES.dropdown_root
        ),
        dropdown: cn(
          "bg-popover absolute inset-0 opacity-0",
          DEFAULT_CLASSNAMES.dropdown
        ),
        caption_label: cn(
          "select-none font-medium",
          captionLayout === "label"
            ? "text-sm"
            : "[&>svg]:text-muted-foreground flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:size-3.5",
          DEFAULT_CLASSNAMES.caption_label
        ),
        table: "w-full border-collapse",
        weekdays: cn("flex", DEFAULT_CLASSNAMES.weekdays),
        weekday: cn(
          "text-muted-foreground flex-1 select-none rounded-md text-[0.8rem] font-normal",
          DEFAULT_CLASSNAMES.weekday
        ),
        week: cn("mt-2 flex w-full", DEFAULT_CLASSNAMES.week),
        week_number_header: cn(
          "w-[--cell-size] select-none",
          DEFAULT_CLASSNAMES.week_number_header
        ),
        week_number: cn(
          "text-muted-foreground select-none text-[0.8rem]",
          DEFAULT_CLASSNAMES.week_number
        ),
        day: cn(
          "group/day relative aspect-square h-full w-full select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
          DEFAULT_CLASSNAMES.day
        ),
        range_start: cn(
          "bg-accent rounded-l-md",
          DEFAULT_CLASSNAMES.range_start
        ),
        range_middle: cn("rounded-none", DEFAULT_CLASSNAMES.range_middle),
        range_end: cn("bg-accent rounded-r-md", DEFAULT_CLASSNAMES.range_end),
        today: cn(
          "bg-accent text-accent-foreground rounded-md data-[selected=true]:rounded-none",
          DEFAULT_CLASSNAMES.today
        ),
        outside: cn(
          "text-muted-foreground aria-selected:text-muted-foreground",
          DEFAULT_CLASSNAMES.outside
        ),
        disabled: cn(
          "text-muted-foreground opacity-50",
          DEFAULT_CLASSNAMES.disabled
        ),
        hidden: cn("invisible", DEFAULT_CLASSNAMES.hidden),
        ...classNames,
      },
      components: {
        Root: CalendarRoot,
        Chevron: CalendarChevron,
        DayButton: CalendarDayButton,
        ...components,
      },
      formatters: {
        formatMonthDropdown: (date: Date) =>
          date.toLocaleString("default", { month: "short" }),
        ...formatters,
      },
    }),
    [classNames, components, formatters, captionLayout, buttonVariant]
  )

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "bg-background group/calendar p-3 [--cell-size:2rem] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className
      )}
      captionLayout={captionLayout}
      formatters={merged.formatters}
      classNames={merged.classNames}
      components={merged.components}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-ring/50 flex aspect-square h-auto w-full min-w-[--cell-size] flex-col gap-1 font-normal leading-none data-[range-end=true]:rounded-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-md group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-[3px] [&>span]:text-xs [&>span]:opacity-70",
        DEFAULT_CLASSNAMES.day,
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
