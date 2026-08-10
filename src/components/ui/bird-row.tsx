import { memo } from 'react'
import { WikiBirdThumbnail } from '@/components/ui/wiki-bird-thumbnail'
import { ListRow } from '@/components/ui/list-row'
import { getDisplayName, getScientificName } from '@/lib/utils'

interface BirdRowProps {
  speciesName: string
  imageUrl?: string
  /** Optional subtitle text below the name (e.g. "3 outings · 5 seen · Jan 1") */
  subtitle?: string
  onClick: () => void
  /** Optional right-side actions rendered after the row content */
  actions?: React.ReactNode
}

export const BirdRow = memo(function BirdRow({ speciesName, imageUrl, subtitle, onClick, actions }: BirdRowProps) {
  const displayName = getDisplayName(speciesName)
  const scientificName = getScientificName(speciesName)

  return (
    <ListRow
      icon={
        <div className="py-1.5">
          {/* allowLookup is false whenever the row already has an image, so a long
              list does not fan out to one Wikipedia request per row. */}
          <WikiBirdThumbnail
            speciesName={speciesName}
            imageUrl={imageUrl}
            allowLookup={!imageUrl}
            alt={displayName}
            className="w-14 h-14 sm:w-16 sm:h-16 md:w-20 md:h-20"
          />
        </div>
      }
      onClick={onClick}
      actions={actions}
    >
      <div className="md:flex md:items-baseline md:gap-2">
        <p className="font-serif font-semibold text-sm text-foreground truncate">
          {displayName}
        </p>
        {scientificName && (
          <p className="text-xs text-muted-foreground italic truncate">
            {scientificName}
          </p>
        )}
      </div>
      {subtitle && (
        <p className="text-xs text-muted-foreground mt-0.5">
          {subtitle}
        </p>
      )}
    </ListRow>
  )
})
