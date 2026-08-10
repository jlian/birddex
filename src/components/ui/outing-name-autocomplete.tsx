import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Outing } from '@/lib/types'

interface OutingNameAutocompleteProps {
  value: string
  onChange: (value: string) => void
  /** All existing outings to search through */
  outings: Outing[]
  /** Called when user selects an outing name from the dropdown */
  onSelect?: (outingName: string) => void
  placeholder?: string
  id?: string
  className?: string
  autoFocus?: boolean
  'aria-label'?: string
}

export function OutingNameAutocomplete({
  value,
  onChange,
  outings,
  onSelect,
  placeholder = 'e.g. Central Park, NYC',
  id,
  className,
  autoFocus,
  'aria-label': ariaLabel,
}: OutingNameAutocompleteProps) {
  const [results, setResults] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Get unique outing names from outings - memoized to avoid repeated sorting
  const uniqueOutingNames = useMemo(() => {
    const names = new Set<string>()
    for (const outing of outings) {
      if (outing.locationName && outing.locationName.trim()) {
        names.add(outing.locationName.trim())
      }
    }
    return Array.from(names).sort()
  }, [outings])

  // Debounced search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const doSearch = useCallback((q: string) => {
    clearTimeout(searchTimeoutRef.current)
    if (!q.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    searchTimeoutRef.current = setTimeout(() => {
      const query = q.toLowerCase().trim()
      const matches = uniqueOutingNames
        .filter(name => name.toLowerCase().includes(query))
        .slice(0, 8) // Limit to 8 results
      setResults(matches)
      setOpen(matches.length > 0)
      setHighlightIndex(-1)
    }, 80)
  }, [uniqueOutingNames])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // The debounce timer is cleared on each new keystroke, but nothing cancelled it
  // on unmount, so a pending search could fire after the component was gone and
  // call setState on a dead tree. Under jsdom that surfaces as "window is not
  // defined" once the environment has been torn down, which failed the suite even
  // though every test passed.
  useEffect(() => () => clearTimeout(searchTimeoutRef.current), [])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightIndex] as HTMLElement
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIndex])

  const selectName = (name: string) => {
    onChange(name)
    onSelect?.(name)
    setOpen(false)
    setResults([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) {
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex(i => (i + 1) % results.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex(i => (i <= 0 ? results.length - 1 : i - 1))
        break
      case 'Enter': {
        let selectedName: string | null = null
        if (highlightIndex >= 0 && highlightIndex < results.length) {
          selectedName = results[highlightIndex]
        } else if (results.length === 1) {
          selectedName = results[0]
        }
        if (selectedName !== null) {
          e.preventDefault()
          selectName(selectedName)
        }
        break
      }
      case 'Escape':
        setOpen(false)
        break
    }
  }

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        aria-label={ariaLabel}
        onChange={e => {
          onChange(e.target.value)
          doSearch(e.target.value)
        }}
        onFocus={() => {
          if (value.trim() && results.length > 0) setOpen(true)
        }}
        onKeyDown={handleKeyDown}
      />
      {open && results.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 top-full left-0 right-0 mt-1 max-h-60 overflow-auto rounded-md border bg-popover shadow-md"
          role="listbox"
        >
          {results.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === highlightIndex}
              className={cn(
                'px-3 py-2 cursor-pointer text-sm transition-colors',
                i === highlightIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              )}
              onMouseDown={e => {
                e.preventDefault() // keep focus on input
                selectName(name)
              }}
            >
              <div className="font-medium">{name}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
