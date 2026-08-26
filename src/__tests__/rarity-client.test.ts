import { describe, expect, it } from 'vitest'
import { localMonth } from '@/lib/rarity-client'

describe('localMonth', () => {
  it('reads the month in the timestamp\'s own timezone', () => {
    // 23:00 on Jan 31 at UTC-08:00 is still January where it happened, but
    // 07:00 on Feb 1 in UTC. Reading it locally would move the sighting into
    // the wrong month and change its verdict.
    expect(localMonth('2026-01-31T23:00:00-08:00')).toBe(1)
    expect(localMonth('2026-02-01T00:30:00+13:00')).toBe(2)
  })

  it('returns null rather than a month for anything unparseable', () => {
    for (const v of [null, undefined, '', 'not a date', '0000:00:00 00:00:00']) {
      expect(localMonth(v)).toBeNull()
    }
  })

  it('rejects a value that merely starts like a date', () => {
    // A prefix match would read this as February and mark a bird on the
    // strength of a string that is not a date at all.
    expect(localMonth('2026-02-not-a-date')).toBeNull()
    expect(localMonth('2026-02-01T99')).toBeNull()
    expect(localMonth('2026-02')).toBeNull()
  })

  it('accepts the shapes actually stored', () => {
    expect(localMonth('2026-03-04')).toBe(3)
    expect(localMonth('2026-03-04T05:06')).toBe(3)
    expect(localMonth('2026-03-04T05:06:07')).toBe(3)
    expect(localMonth('2026-03-04T05:06:07.123Z')).toBe(3)
    expect(localMonth('2026-03-04 05:06:07-08:00')).toBe(3)
  })

  it('rejects an out-of-range month instead of clamping it', () => {
    expect(localMonth('2026-13-01T00:00:00Z')).toBeNull()
    expect(localMonth('2026-00-01T00:00:00Z')).toBeNull()
  })
})
