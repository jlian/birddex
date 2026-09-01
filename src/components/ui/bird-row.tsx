import { memo } from 'react'
import { WikiBirdThumbnail } from '@/components/ui/wiki-bird-thumbnail'
import { ListRow } from '@/components/ui/list-row'
import { RarityMark } from '@/components/ui/rarity-mark'
import { useRarity, localMonth } from '@/lib/rarity-client'
import { getDisplayName, getScientificName } from '@/lib/utils'

interface BirdRowProps {
  speciesName: string
  commonName?: string
  scientificName?: string
  imageUrl?: string
  /** Optional subtitle text below the name (e.g. "3 outings · 5 seen · Jan 1") */
  subtitle?: string
  onClick: () => void
  /** Optional right-side actions rendered after the row content */
  actions?: React.ReactNode
  /** The place and date this row belongs to, which is what a rarity verdict
   *  needs. Omitted on the life list, where an entry spans many places and
   *  months and has no single answer. */
  outing?: { lat?: number | null; lon?: number | null; startTime?: string | null }
}

export const BirdRow = memo(function BirdRow({ speciesName, commonName, scientificName: canonicalScientificName, imageUrl, subtitle, onClick, actions, outing }: BirdRowProps) {
  const displayName = commonName ?? getDisplayName(speciesName)
  const scientificName = canonicalScientificName ?? getScientificName(speciesName)
  const rarity = useRarity(speciesName, outing?.lat, outing?.lon, localMonth(outing?.startTime))

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
        {/* The mark sits OUTSIDE the truncating element. Inside it, a long
            species name would ellipsize the verdict away on exactly the narrow
            rows where truncation kicks in. */}
        <p className="font-serif font-semibold text-sm text-foreground flex items-baseline gap-1.5 min-w-0">
          <span className="truncate">{displayName}</span>
          <RarityMark state={rarity} />
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
