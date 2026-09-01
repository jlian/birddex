import { describe, expect, it } from 'vitest'

import { groupOutingObservations } from '@/components/pages/OutingsPage'
import type { Observation } from '@/lib/types'

function observation(id: string, taxonCode?: string): Observation {
  return {
    id,
    outingId: 'outing-1',
    speciesName: `Kiwi label ${id}`,
    speciesCode: 'sobkiw1',
    taxonCode,
    count: 1,
    certainty: 'confirmed',
    notes: '',
  }
}

describe('groupOutingObservations', () => {
  it.each([
    ['unanimous exact codes', ['sobkiw2', 'sobkiw2'], 'sobkiw2'],
    ['mixed exact codes', ['sobkiw2', 'sobkiw3'], 'sobkiw1'],
    ['known and missing exact codes', ['sobkiw2', undefined], 'sobkiw1'],
    ['all missing exact codes', [undefined, undefined], 'sobkiw1'],
  ] as const)('uses consensus identity for %s', (_label, taxonCodes, expected) => {
    const grouped = groupOutingObservations(
      taxonCodes.map((taxonCode, index) => observation(String(index), taxonCode))
    )

    expect(grouped).toHaveLength(1)
    expect(grouped[0].taxonCode).toBe(expected)
  })
})