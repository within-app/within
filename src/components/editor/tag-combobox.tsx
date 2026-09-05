"use client"

import { useState, useEffect, useRef } from "react"
import { X, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/components/locale-provider"
import type { Tag } from "@/types/journal"

interface TagComboboxProps {
  selectedTags: Tag[]
  onChange: (tags: Tag[]) => void
}

export function TagCombobox({ selectedTags, onChange }: TagComboboxProps) {
  const { messages } = useI18n()
  const tagMessages = messages.editor.tags
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [allTags, setAllTags] = useState<Tag[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/tags")
      .then((r) => r.json())
      .then((tags: Tag[]) => { if (!cancelled) setAllTags(tags) })
      .catch(console.error)
    return () => { cancelled = true }
  }, [])

  const selectedIds = new Set(selectedTags.map((t) => t.id))

  const filtered = allTags.filter(
    (t) =>
      !selectedIds.has(t.id) &&
      t.name.toLowerCase().includes(input.toLowerCase())
  )

  const inputMatchesExisting = allTags.some(
    (t) => t.name.toLowerCase() === input.trim().toLowerCase()
  )

  function addTag(tag: Tag) {
    onChange([...selectedTags, tag])
    setInput("")
    setOpen(false)
  }

  function createTag() {
    const name = input.trim()
    if (!name || inputMatchesExisting) return
    const tempId = `new-${Date.now()}`
    addTag({ id: tempId, name })
  }

  function removeTag(id: string) {
    onChange(selectedTags.filter((t) => t.id !== id))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {selectedTags.map((tag) => (
          <Badge key={tag.id} variant="secondary" className="gap-1 pr-1">
            {tag.name}
            <button
              type="button"
              onClick={() => removeTag(tag.id)}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              aria-label={tagMessages.removeAria(tag.name)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-muted-foreground">
            <Plus className="h-3.5 w-3.5" />
            {tagMessages.addButton}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput
              ref={inputRef}
              placeholder={tagMessages.searchPlaceholder}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim() && filtered.length === 0) {
                  e.preventDefault()
                  createTag()
                }
              }}
            />
            <CommandList>
              <CommandEmpty>
                {input.trim() ? (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                    onClick={createTag}
                  >
                    <Plus className="inline h-3.5 w-3.5 mr-1.5" />
                    {tagMessages.createLabel(input.trim())}
                  </button>
                ) : (
                  <span className="px-3 py-2 text-sm text-muted-foreground">{tagMessages.empty}</span>
                )}
              </CommandEmpty>
              <CommandGroup>
                {filtered.map((tag) => (
                  <CommandItem key={tag.id} onSelect={() => addTag(tag)}>
                    {tag.name}
                  </CommandItem>
                ))}
                {input.trim() && !inputMatchesExisting && filtered.length > 0 && (
                  <CommandItem onSelect={createTag} className="text-muted-foreground">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    {tagMessages.createLabel(input.trim())}
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
