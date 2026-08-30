import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { BirdLogo } from '@/components/ui/bird-logo'
import { useBirdImage } from '@/hooks/use-bird-image'
import { cn } from '@/lib/utils'

// iOS Safari can repaint/flicker thumbnail layers during interactive back-swipe
// when images decode late; keep eager loading on iOS, lazy elsewhere.
const SHOULD_LAZY_LOAD_THUMBNAILS = (() => {
  if (typeof navigator === 'undefined') return true
  const userAgent = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(userAgent)
    || (userAgent.includes('Mac') && navigator.maxTouchPoints > 1)
  return !isIOS
})()

import type { GalleryImage } from '@/lib/wikimedia'

interface WikiBirdThumbnailProps {
  speciesName: string
  imageUrl?: string
  galleryImages?: GalleryImage[]
  allowLookup?: boolean
  alt?: string
  className?: string
  loading?: boolean
  /** Called when the displayed image changes, with the current gallery image */
  onImageChange?: (image: GalleryImage | undefined) => void
}

/**
 * Square, center-cropped Wikipedia bird thumbnail.
 * When galleryImages are provided, swipe or use arrow buttons to navigate.
 */
export function WikiBirdThumbnail({
  speciesName,
  imageUrl: imageUrlProp,
  galleryImages,
  allowLookup = true,
  alt,
  className,
  loading: externalLoading,
  onImageChange,
}: WikiBirdThumbnailProps) {
  const hookUrl = useBirdImage(imageUrlProp || !allowLookup ? undefined : speciesName)
  const primaryUrl = imageUrlProp || hookUrl

  // Build combined image list: primary (if provided) + gallery
  const galleryItems = useMemo(() => galleryImages ?? [], [galleryImages])
  const allImages: GalleryImage[] = useMemo(() => {
    if (!primaryUrl) return galleryItems
    let title = ''
    try { title = decodeURIComponent(primaryUrl.split('/').pop()?.replace(/^\d+px-/, '') ?? '') } catch { title = primaryUrl.split('/').pop() ?? '' }
    return [{ url: primaryUrl, title }, ...galleryItems]
  }, [primaryUrl, galleryItems])
  const allUrls = allImages.map(img => img.url)

  const [index, setIndex] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const didSwipe = useRef(false)

  // Reset index when species changes
  useEffect(() => {
    setIndex(0)
  }, [speciesName])

  const total = allUrls.length
  const safeIndex = total > 0 ? Math.min(index, total - 1) : 0
  const currentUrl = total > 0 ? allUrls[safeIndex] : undefined
  const currentImage = useMemo(() => total > 0 ? allImages[safeIndex] : undefined, [allImages, safeIndex, total])
  const hasMultiple = total > 1

  // Notify parent when displayed image changes
  useEffect(() => {
    onImageChange?.(currentImage)
  }, [currentImage, onImageChange])

  const goNext = useCallback(() => {
    if (!hasMultiple) return
    setIndex((i) => (i + 1) % total)
  }, [hasMultiple, total])

  const goPrev = useCallback(() => {
    if (!hasMultiple) return
    setIndex((i) => (i - 1 + total) % total)
  }, [hasMultiple, total])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    didSwipe.current = false
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null || !hasMultiple) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) < 30) return
    didSwipe.current = true
    if (dx < 0) goNext()
    else goPrev()
  }, [hasMultiple, goNext, goPrev])

  const handleClick = useCallback(() => {
    if (didSwipe.current) { didSwipe.current = false; return }
    goNext()
  }, [goNext])

  return (
    <div
      className={cn(
        'aspect-square rounded-lg overflow-hidden bg-muted/20 relative group',
        className,
      )}
      onClick={hasMultiple ? handleClick : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {currentUrl ? (
        <img
          key={currentUrl}
          src={currentUrl}
          alt={alt ?? speciesName}
          loading={SHOULD_LAZY_LOAD_THUMBNAILS ? 'lazy' : 'eager'}
          className="w-full h-full object-cover object-center"
        />
      ) : (
        <div
          className={cn(
            'w-full h-full flex items-center justify-center',
            externalLoading && 'animate-pulse',
          )}
        >
          <BirdLogo size={24} className="text-muted-foreground/40" />
        </div>
      )}

      {/* Arrow buttons (hover only, touch devices use swipe) */}
      {hasMultiple && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            className="absolute left-0 top-0 bottom-0 w-8 flex items-center justify-center
              opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-200
              bg-gradient-to-r from-black/20 to-transparent text-white/80 hover:text-white"
            aria-label="Previous image"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="drop-shadow">
              <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goNext() }}
            className="absolute right-0 top-0 bottom-0 w-8 flex items-center justify-center
              opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-200
              bg-gradient-to-l from-black/20 to-transparent text-white/80 hover:text-white"
            aria-label="Next image"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="drop-shadow">
              <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </>
      )}

      {/* Dot indicators */}
      {hasMultiple && (
        <div className="absolute bottom-1.5 left-0 right-0 flex justify-center gap-1">
          {allUrls.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setIndex(i)
              }}
              className={cn(
                'w-1.5 h-1.5 rounded-full transition-all duration-200',
                i === Math.min(index, total - 1)
                  ? 'bg-white scale-110'
                  : 'bg-white/40 hover:bg-white/60',
              )}
              aria-label={`Image ${i + 1} of ${total}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
