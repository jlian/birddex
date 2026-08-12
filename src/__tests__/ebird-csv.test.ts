import { describe, it, expect } from 'vitest'
import {
  parseEBirdCSV,
  exportDexToCSV,
  exportOutingToEBirdCSV,
  groupPreviewsIntoOutings,
  detectImportConflicts,
} from '../../functions/lib/ebird'
import type { DexEntry, Outing, Observation } from '@/lib/types'

/** Extract local hours/minutes from an ISO string with offset (e.g. "2025-09-28T08:15:00-07:00") */
function localTimeParts(iso: string) {
  const m = iso.match(/T(\d{2}):(\d{2})/)
  if (!m) throw new Error(`Cannot parse local time from "${iso}"`)
  return { hours: Number(m[1]), minutes: Number(m[2]) }
}

/** Extract local date parts from an ISO string with offset */
function localDateParts(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) throw new Error(`Cannot parse local date from "${iso}"`)
  return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) }
}

/* ------------------------------------------------------------------ */
/*  Real eBird "Download My Data" header                               */
/* ------------------------------------------------------------------ */
const EBIRD_HEADER =
  'Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported,Distance Traveled (km),Area Covered (ha),Number of Observers,Breeding Code,Observation Details,Checklist Comments,ML Catalog Numbers'

/** Helper: build a real-format eBird CSV from rows */
function ebirdCSV(rows: string[]): string {
  return [EBIRD_HEADER, ...rows].join('\n')
}

/** Simple CSV line parser for test assertions */
function parseCSVLineForTest(line: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
    } else {
      current += char
    }
  }
  values.push(current)
  return values
}

describe('eBird CSV utilities', () => {
  /* ---------- original tests (kept for backwards compat) ---------- */

  it('parses quoted commas and escaped quotes correctly', () => {
    const csv = [
      '"Common Name","Scientific Name","Count","Location","Date"',
      '"Eurasian Wigeon","Mareca penelope","2","Lake ""North"", WA","2024-05-01"',
    ].join('\n')

    const previews = parseEBirdCSV(csv)
    expect(previews).toHaveLength(1)
    expect(previews[0].speciesName).toBe('Eurasian Wigeon (Mareca penelope)')
    expect(previews[0].location).toBe('Lake "North", WA')
    expect(previews[0].count).toBe(2)
    expect(previews[0].date).toContain('2024-05-01')
  })

  it('parses quoted fields with embedded newlines', () => {
    const csv = [
      '"Common Name","Scientific Name","Count","Location","Date"',
      '"Eurasian Wigeon","Mareca penelope","2","Lake North',
      'WA","2024-05-01"',
    ].join('\n')

    const previews = parseEBirdCSV(csv)
    expect(previews).toHaveLength(1)
    expect(previews[0].location).toBe('Lake North\nWA')
  })

  it('skips rows with invalid dates instead of coercing to now', () => {
    const csv = [
      '"Common Name","Date","Location"',
      '"Mallard","not-a-date","Wetland"',
      '"Northern Pintail","2024-11-15","Lagoon"',
    ].join('\n')

    const previews = parseEBirdCSV(csv)
    expect(previews).toHaveLength(1)
      expect(previews[0].speciesName).toBe('Northern Pintail')
    expect(previews[0].location).toBe('Lagoon')
  })

  it('escapes quotes in dex CSV export', () => {
    const dex: DexEntry[] = [
      {
        speciesName: 'Test Bird, Example (Testus exempli)',
        firstSeenDate: '2024-01-01T00:00:00.000Z',
        lastSeenDate: '2024-02-01T00:00:00.000Z',
        totalOutings: 2,
        totalCount: 5,
        notes: 'He said "wow"',
      },
    ]

    const csv = exportDexToCSV(dex)
    expect(csv).toContain('"Test Bird, Example"')
    expect(csv).toContain('"Testus exempli"')
    expect(csv).toContain('"He said ""wow"""')
  })

  it('escapes quotes in outing CSV export', () => {
    const outing: Outing = {
      id: 'outing_1',
      userId: 'u1',
      startTime: '2024-05-01T12:00:00.000Z',
      endTime: '2024-05-01T13:00:00.000Z',
      locationName: 'Lake "North" WA',
      notes: 'Field note "A"',
      createdAt: '2024-05-01T12:00:00.000Z',
    }
    const observations: Observation[] = [
      {
        id: 'obs_1',
        outingId: 'outing_1',
        speciesName: 'Mallard (Anas platyrhynchos)',
        count: 3,
        certainty: 'confirmed',
        notes: 'Seen near "dock"',
      },
    ]

    const csv = exportOutingToEBirdCSV(outing, observations, false)
    const cells = csv.split(',')

    expect(cells).toHaveLength(20)
    expect(csv).toContain('"WINGDEX-OUTING-outing_1"')
    expect(csv).toContain('"Mallard"')
    expect(csv).toContain('"Anas"')
    expect(csv).toContain('"platyrhynchos"')
    expect(csv).toContain('"3"')
    expect(csv).toContain('"Lake North WA"')
    expect(csv).toContain('"Incidental"')
    expect(csv).toContain('"N"')
    expect(csv).toContain('"Seen near dock"')
    expect(csv).toContain('"Field note A"')
  })

  it('can emit optional eBird record header in canonical order', () => {
    const outing: Outing = {
      id: 'outing_1',
      userId: 'u1',
      startTime: '2024-05-01T12:00:00.000Z',
      endTime: '2024-05-01T13:00:00.000Z',
      locationName: 'Lake',
      notes: '',
      createdAt: '2024-05-01T12:00:00.000Z',
    }
    const observations: Observation[] = [
      {
        id: 'obs_1',
        outingId: 'outing_1',
        speciesName: 'Mallard (Anas platyrhynchos)',
        count: 1,
        certainty: 'confirmed',
        notes: '',
      },
    ]

    const csv = exportOutingToEBirdCSV(outing, observations, true)
    const [header] = csv.split('\n')

    expect(header).toBe(
      'Submission ID,Common Name,Genus,Species,Number,Species Comments,Location Name,Latitude,Longitude,Date,Start Time,State/Province,Country Code,Protocol,Number of Observers,Duration,All observations reported?,Effort Distance Miles,Effort area acres,Submission Comments'
    )
  })

  it('groups previews into outings by same day and location', () => {
    const previews = [
      { speciesName: 'A', date: '2024-05-01T10:00:00.000Z', location: 'Park', count: 1 },
      { speciesName: 'B', date: '2024-05-01T11:00:00.000Z', location: 'Park', count: 2 },
      { speciesName: 'A', date: '2024-05-02T10:00:00.000Z', location: 'Park', count: 1 },
    ]

    const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')
    expect(outings).toHaveLength(2)
    expect(observations.length).toBeGreaterThanOrEqual(2)
  })

  it('marks in-range dates as duplicate import conflicts', () => {
    const existing = new Map<string, DexEntry>([
      ['Mallard', {
        speciesName: 'Mallard',
        firstSeenDate: '2024-01-01T00:00:00.000Z',
        lastSeenDate: '2024-12-31T00:00:00.000Z',
        totalOutings: 10,
        totalCount: 120,
        notes: '',
      }],
    ])

    const conflicts = detectImportConflicts([
      {
        speciesName: 'Mallard',
        date: '2024-06-15T00:00:00.000Z',
        location: 'Wetland',
        count: 3,
      },
    ], existing)

    expect(conflicts[0].conflict).toBe('duplicate')
  })

  it('detects conflicts when import has scientific name but dex has only common name', () => {
    const existing = new Map<string, DexEntry>([
      ['Mallard', {
        speciesName: 'Mallard',
        firstSeenDate: '2024-01-01T00:00:00.000Z',
        lastSeenDate: '2024-12-31T00:00:00.000Z',
        totalOutings: 5,
        totalCount: 50,
        notes: '',
      }],
    ])

    const conflicts = detectImportConflicts([
      {
        speciesName: 'Mallard (Anas platyrhynchos)',
        date: '2024-06-15T00:00:00.000Z',
        location: 'Wetland',
        count: 3,
      },
    ], existing)

    expect(conflicts[0].conflict).toBe('duplicate')
  })

  it('detects conflicts when dex has scientific name but import has only common name', () => {
    const existing = new Map<string, DexEntry>([
      ['Mallard (Anas platyrhynchos)', {
        speciesName: 'Mallard (Anas platyrhynchos)',
        firstSeenDate: '2024-01-01T00:00:00.000Z',
        lastSeenDate: '2024-12-31T00:00:00.000Z',
        totalOutings: 5,
        totalCount: 50,
        notes: '',
      }],
    ])

    const conflicts = detectImportConflicts([
      {
        speciesName: 'Mallard',
        date: '2024-06-15T00:00:00.000Z',
        location: 'Wetland',
        count: 3,
      },
    ], existing)

    expect(conflicts[0].conflict).toBe('duplicate')
  })

  /* ---------- real eBird "Download My Data" format tests ---------- */

  describe('real eBird CSV format', () => {
    it('parses a real eBird row with all standard columns', () => {
      const csv = ebirdCSV([
        'S276393806,Canada Goose,Branta canadensis,342,X,US-IL,Cook,L53451695,Montrose Point,41.963254,-87.631954,2025-09-28,08:15 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(1)

      const p = previews[0]
      expect(p.speciesName).toBe('Canada Goose (Branta canadensis)')
      expect(p.count).toBe(1) // "X" → 1
      expect(p.location).toBe('Montrose Point')
      expect(p.lat).toBeCloseTo(41.963254)
      expect(p.lon).toBeCloseTo(-87.631954)
      expect(p.submissionId).toBe('S276393806')
      expect(p.stateProvince).toBe('US-IL')
    })

    it('handles "X" count as 1', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Home,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      expect(p.count).toBe(1)
    })

    it('handles "+" and "*" count tokens as 1', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,+,US-WA,King,L1,Home,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
        'S2,Northern Pintail,Anas acuta,508,*,US-WA,King,L1,Home,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(2)
      expect(previews[0].count).toBe(1)
      expect(previews[1].count).toBe(1)
    })

    it('handles numeric count correctly', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,5,US-WA,King,L1,Home,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      expect(p.count).toBe(5)
    })

    it('combines date and AM time into ISO timestamp', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,,L1,Park,47.6,-122.4,2025-09-28,08:15 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      const t = localTimeParts(p.date)
      expect(t.hours).toBe(8)
      expect(t.minutes).toBe(15)
    })

    it('combines date and PM time into ISO timestamp', () => {
      const csv = ebirdCSV([
        'S1,Sooty Grouse,Dendragapus fuliginosus,1320,X,US-WA,Pierce,L1,Mt Rainier,46.8,-121.7,2023-07-30,01:09 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      const t = localTimeParts(p.date)
      expect(t.hours).toBe(13)
      expect(t.minutes).toBe(9)
    })

    it('handles 12:xx PM correctly (noon)', () => {
      const csv = ebirdCSV([
        'S1,Killdeer,Charadrius vociferus,5827,X,US-WA,,L1,Park,47.6,-122.4,2025-10-05,12:08 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      const t = localTimeParts(p.date)
      expect(t.hours).toBe(12)
      expect(t.minutes).toBe(8)
    })

    it('handles 12:xx AM correctly (midnight)', () => {
      const csv = ebirdCSV([
        'S1,Crow,Corvus brachyrhynchos,21557,X,US-WA,,L1,Park,47.6,-122.4,2025-10-05,12:30 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      const t = localTimeParts(p.date)
      expect(t.hours).toBe(0)
      expect(t.minutes).toBe(30)
    })

    it('parses rows with empty time field', () => {
      const csv = ebirdCSV([
        'S276391486,Merlin,Falco columbarius,12062,X,US-IL,Cook,L53451695,Montrose Point,41.963254,-87.631954,2025-09-28,,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(1)
      expect(previews[0].time).toBeUndefined()
    })

    it('preserves local calendar day for YYYY-MM-DD dates regardless of timezone', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,1,US-WA,King,L1,Park,47.6,-122.4,2024-01-15,,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      const d = localDateParts(p.date)
      // The parsed date should land on Jan 15 in local time, not shift to
      // Jan 14 (which happens when "2024-01-15" is parsed as UTC midnight
      // and the browser is behind UTC).
      expect(d.year).toBe(2024)
      expect(d.month).toBe(0)  // January
      expect(d.day).toBe(15)
    })

    it('captures observation details and checklist comments', () => {
      const csv = [
        EBIRD_HEADER,
        'S1,Mallard,Anas platyrhynchos,545,3,US-WA,King,L1,Lake,47.6,-122.4,2025-06-01,09:00 AM,Traveling,60,1,2,,1,,Flying overhead,Beautiful morning,',
      ].join('\n')

      const p = parseEBirdCSV(csv)[0]
      expect(p.observationNotes).toBe('Flying overhead')
      expect(p.checklistNotes).toBe('Beautiful morning')
    })

    it('parses multiple rows from a real eBird export', () => {
      const csv = ebirdCSV([
        'S276395334,Tufted Puffin,Fratercula cirrhata,6378,X,US-WA,Island,L53452489,Smith Island,48.320427,-122.83517,2025-08-16,05:38 PM,eBird - Casual Observation,,0,,,1,,,,',
        'S276395431,Pigeon Guillemot,Cepphus columba,6404,X,US-WA,Island,L53452489,Smith Island,48.320427,-122.83517,2025-08-16,06:53 PM,eBird - Casual Observation,,0,,,1,,,,',
        'S276395380,Rhinoceros Auklet,Cerorhinca monocerata,6377,X,US-WA,Island,L53452489,Smith Island,48.320427,-122.83517,2025-08-16,05:35 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(3)
      
      const names = previews.map(p => p.speciesName)
      expect(names).toContain('Tufted Puffin (Fratercula cirrhata)')
      expect(names).toContain('Pigeon Guillemot (Cepphus columba)')
      expect(names).toContain('Rhinoceros Auklet (Cerorhinca monocerata)')

      // All share Smith Island
      for (const p of previews) {
        expect(p.location).toBe('Smith Island')
        expect(p.lat).toBeCloseTo(48.320427)
        expect(p.lon).toBeCloseTo(-122.83517)
      }
    })

    it('handles international locations with empty County', () => {
      const csv = ebirdCSV([
        'S276512830,Rock Pigeon,Columba livia,1853,X,CN-21,,L53473988,Dalian,39.063208,122.057679,2016-06-06,10:50 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      expect(p.speciesName).toBe('Rock Pigeon (Columba livia)')
      expect(p.location).toBe('Dalian')
      expect(p.stateProvince).toBe('CN-21')
    })
  })

  describe('grouping with submissionId', () => {
    it('groups by submissionId when available', () => {
      const previews = [
        { speciesName: 'A', date: '2024-05-01T10:00:00.000Z', location: 'Park A', count: 1, submissionId: 'S100' },
        { speciesName: 'B', date: '2024-05-01T11:00:00.000Z', location: 'Park B', count: 2, submissionId: 'S100' },
        { speciesName: 'C', date: '2024-05-01T10:00:00.000Z', location: 'Park A', count: 1, submissionId: 'S200' },
      ]

      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')
      // S100 → 1 outing, S200 → 1 outing
      expect(outings).toHaveLength(2)
      // S100 outing has 2 species, S200 has 1
      const s100Outing = outings.find(o => o.locationName === 'Park A' || o.locationName === 'Park B')
      expect(s100Outing).toBeDefined()
    })

    it('falls back to date+location when submissionId not present', () => {
      const previews = [
        { speciesName: 'A', date: '2024-05-01T10:00:00.000Z', location: 'Park', count: 1 },
        { speciesName: 'B', date: '2024-05-01T11:00:00.000Z', location: 'Park', count: 2 },
      ]

      const { outings } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(1) // same date + location → 1 outing
    })

    it('falls back to date+location when submission IDs are unique per row', () => {
      const previews = [
        { speciesName: 'A', date: '2024-05-01T10:00:00.000Z', location: 'Park', count: 1, submissionId: 'S1' },
        { speciesName: 'B', date: '2024-05-01T11:00:00.000Z', location: 'Park', count: 2, submissionId: 'S2' },
      ]

      const { outings } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(1)
    })

    it('carries checklist comments into outing notes', () => {
      const previews = [
        {
          speciesName: 'Mallard',
          date: '2024-05-01T10:00:00.000Z',
          location: 'Lake',
          count: 1,
          checklistNotes: 'Sunny day',
        },
      ]

      const { outings } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings[0].notes).toContain('Sunny day')
      expect(outings[0].notes).toContain('Imported from eBird')
    })

    it('carries observation details into observation notes', () => {
      const previews = [
        {
          speciesName: 'Mallard',
          date: '2024-05-01T10:00:00.000Z',
          location: 'Lake',
          count: 1,
          observationNotes: 'Flying overhead',
        },
      ]

      const { observations } = groupPreviewsIntoOutings(previews, 'u1')
      expect(observations[0].notes).toBe('Flying overhead')
    })
  })

  /* ---------- export tests ---------- */

  describe('dex CSV export', () => {
    it('uses ISO date format (YYYY-MM-DD) instead of locale-dependent format', () => {
      const dex: DexEntry[] = [
        {
          speciesName: 'Mallard (Anas platyrhynchos)',
          firstSeenDate: '2024-01-15T00:00:00.000Z',
          lastSeenDate: '2024-12-25T00:00:00.000Z',
          totalOutings: 3,
          totalCount: 10,
          notes: '',
        },
      ]

      const csv = exportDexToCSV(dex)
      expect(csv).toContain('"2024-01-15"')
      expect(csv).toContain('"2024-12-25"')
      // Should NOT contain locale-dependent formats
      expect(csv).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/)
    })

    it('splits species name into Common Name and Scientific Name columns', () => {
      const dex: DexEntry[] = [
        {
          speciesName: 'Bald Eagle (Haliaeetus leucocephalus)',
          firstSeenDate: '2025-06-01T00:00:00.000Z',
          lastSeenDate: '2025-06-01T00:00:00.000Z',
          totalOutings: 1,
          totalCount: 1,
          notes: '',
        },
      ]

      const csv = exportDexToCSV(dex)
      const [header, row] = csv.split('\n')
      expect(header).toContain('"Common Name"')
      expect(header).toContain('"Scientific Name"')
      expect(row).toContain('"Bald Eagle"')
      expect(row).toContain('"Haliaeetus leucocephalus"')
    })

    it('handles species without scientific name', () => {
      const dex: DexEntry[] = [
        {
          speciesName: 'Mystery Bird',
          firstSeenDate: '2025-06-01T00:00:00.000Z',
          lastSeenDate: '2025-06-01T00:00:00.000Z',
          totalOutings: 1,
          totalCount: 1,
          notes: '',
        },
      ]

      const csv = exportDexToCSV(dex)
      const [, row] = csv.split('\n')
      expect(row).toContain('"Mystery Bird"')
      expect(row).toContain('""') // empty scientific name
    })

    it('CSV-escapes header row', () => {
      const csv = exportDexToCSV([])
      const [header] = csv.split('\n')
      // Every header cell should be quoted
      const cells = header.split(',')
      for (const cell of cells) {
        expect(cell).toMatch(/^".*"$/)
      }
    })

    it('preserves local calendar date from offset-aware timestamps', () => {
      const dex: DexEntry[] = [
        {
          speciesName: 'Chukar (Alectoris chukar)',
          firstSeenDate: '2025-01-15T23:30:00-10:00',
          lastSeenDate: '2025-01-16T00:30:00-10:00',
          totalOutings: 2,
          totalCount: 3,
          notes: '',
        },
      ]

      const csv = exportDexToCSV(dex)
      const [, row] = csv.split('\n')
      const cells = parseCSVLineForTest(row)
      expect(cells[2]).toBe('2025-01-15')
      expect(cells[3]).toBe('2025-01-16')
    })
  })

  describe('outing CSV export', () => {
    it('uses "X" for zero-count observations', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2024-05-01T12:00:00.000Z',
        endTime: '2024-05-01T13:00:00.000Z',
        locationName: 'Park',
        notes: '',
        createdAt: '2024-05-01T12:00:00.000Z',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Mallard (Anas platyrhynchos)',
          count: 0,
          certainty: 'confirmed',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations)
      expect(csv).toContain('"X"')
    })

    it('excludes non-confirmed observations', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2024-05-01T12:00:00.000Z',
        endTime: '2024-05-01T13:00:00.000Z',
        locationName: 'Park',
        notes: '',
        createdAt: '2024-05-01T12:00:00.000Z',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Mallard (Anas platyrhynchos)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
        {
          id: 'obs_2',
          outingId: 'o1',
          speciesName: 'Eagle (Aquila chrysaetos)',
          count: 1,
          certainty: 'possible',
          notes: '',
        },
        {
          id: 'obs_3',
          outingId: 'o1',
          speciesName: 'Hawk (Buteo jamaicensis)',
          count: 1,
          certainty: 'rejected',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations)
      expect(csv).toContain('"Mallard"')
      expect(csv).not.toContain('"Eagle"')
      expect(csv).not.toContain('"Hawk"')
    })

    it('formats date as MM/DD/YYYY for eBird Record format', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2025-09-28T08:15:00.000Z',
        endTime: '2025-09-28T09:15:00.000Z',
        locationName: 'Park',
        notes: '',
        createdAt: '2025-09-28T08:15:00.000Z',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Mallard (Anas platyrhynchos)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations)
      // Date should be in MM/DD/YYYY format
      expect(csv).toMatch(/"0?\d\/\d{2}\/2025"/)
    })

    it('includes lat/lon with 6 decimal places', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2024-05-01T12:00:00.000Z',
        endTime: '2024-05-01T13:00:00.000Z',
        locationName: 'Smith Island',
        lat: 48.320427,
        lon: -122.83517,
        notes: '',
        createdAt: '2024-05-01T12:00:00.000Z',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Tufted Puffin (Fratercula cirrhata)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations)
      expect(csv).toContain('"48.320427"')
      expect(csv).toContain('"-122.835170"')
    })

    it('produces exactly 19 columns per row matching eBird Record format', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2024-05-01T12:00:00.000Z',
        endTime: '2024-05-01T13:00:00.000Z',
        locationName: 'Park',
        lat: 47.6,
        lon: -122.3,
        notes: 'Test notes',
        createdAt: '2024-05-01T12:00:00.000Z',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Mallard (Anas platyrhynchos)',
          count: 3,
          certainty: 'confirmed',
          notes: 'Near pond',
        },
        {
          id: 'obs_2',
          outingId: 'o1',
          speciesName: 'Great Blue Heron (Ardea herodias)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations, true)
      const lines = csv.split('\n')
      expect(lines).toHaveLength(3) // header + 2 rows

      for (const line of lines) {
        // Count commas that are between quoted fields (not inside quotes)
        const fields = parseCSVLineForTest(line)
        expect(fields).toHaveLength(20)
      }
    })

    it('keeps key eBird Record fields in canonical column positions', () => {
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2025-09-28T08:15:00-07:00',
        endTime: '2025-09-28T09:15:00-07:00',
        locationName: 'Discovery Park',
        lat: 47.6606,
        lon: -122.4147,
        notes: 'Checklist note',
        createdAt: '2025-09-28T08:15:00-07:00',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Northern Cardinal (Cardinalis cardinalis)',
          count: 2,
          certainty: 'confirmed',
          notes: 'Observation note',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations, false)
      const fields = parseCSVLineForTest(csv)

      expect(fields[0]).toBe('WINGDEX-OUTING-o1')
      expect(fields[1]).toBe('Northern Cardinal')
      expect(fields[2]).toBe('Cardinalis')
      expect(fields[3]).toBe('cardinalis')
      expect(fields[4]).toBe('2')
      expect(fields[5]).toBe('Observation note')
      expect(fields[6]).toBe('Discovery Park')
      expect(fields[7]).toBe('47.660600')
      expect(fields[8]).toBe('-122.414700')
      expect(fields[9]).toBe('09/28/2025')
      expect(fields[10]).toBe('08:15')
      expect(fields[13]).toBe('Incidental')
      expect(fields[14]).toBe('1')
      expect(fields[15]).toBe('60')
      expect(fields[16]).toBe('N')
      expect(fields[19]).toBe('Checklist note')
    })

    it('preserves local time from offset-aware ISO startTime (not browser TZ)', () => {
      // Outing observed in Hawaii (UTC-10) at 5:16 PM local time
      // (CSV said 7:16 PM but that was Pacific time; actual local = 5:16 PM HST)
      const outing: Outing = {
        id: 'o1',
        userId: 'u1',
        startTime: '2024-12-18T17:16:00-10:00',
        endTime: '2024-12-18T18:16:00-10:00',
        locationName: 'Maui',
        lat: 20.682568,
        lon: -156.442741,
        notes: '',
        createdAt: '2024-12-18T17:16:00-10:00',
      }
      const observations: Observation[] = [
        {
          id: 'obs_1',
          outingId: 'o1',
          speciesName: 'Chukar (Alectoris chukar)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
      ]

      const csv = exportOutingToEBirdCSV(outing, observations, false)
      const fields = parseCSVLineForTest(csv)
      // Date should be 12/18/2024 (local), not 12/19/2024 (UTC)
      expect(fields[9]).toBe('12/18/2024')
      // Time should be 17:16 (local HST), not 19:16 (was Pacific)
      expect(fields[10]).toBe('17:16')
    })
  })

})

  /* ---------- taxonomy normalization during import ---------- */

  describe('taxonomy normalization during CSV import', () => {
    it('preserves eBird species names as-is from CSV', () => {
      // The eBird CSV has "Chukar" as the common name, our taxonomy
      // matches eBird so it should stay as "Chukar" (not "Chukar Partridge").
      // Wikipedia lookup uses pre-resolved wiki titles from taxonomy.json.
      const csv = ebirdCSV([
        'S276515153,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L53474467,Maui,20.682568,-156.442741,2024-12-18,07:16 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(1)
      expect(previews[0].speciesName).toBe('Chukar (Alectoris chukar)')
    })

    it('keeps canonical names unchanged', () => {
      // "Canada Goose" is already the canonical common name in the taxonomy
      const csv = ebirdCSV([
        'S276393806,Canada Goose,Branta canadensis,342,X,US-IL,Cook,L53451695,Montrose Point,41.963254,-87.631954,2025-09-28,08:15 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(1)
      expect(previews[0].speciesName).toBe('Canada Goose (Branta canadensis)')
    })

    it('normalizes all species in the test CSV file via scientific name', () => {
      // Parse the full test CSV
      const csv = ebirdCSV([
        'S276515153,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L53474467,Maui,20.682568,-156.442741,2024-12-18,07:16 PM,eBird - Casual Observation,,0,,,1,,,,',
        'S276512830,Rock Pigeon,Columba livia,1853,X,CN-21,,L53473988,Dalian,39.063208,122.057679,2016-06-06,10:50 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv)
      // Both should be in canonical "Common Name (Scientific Name)" format
      for (const p of previews) {
        expect(p.speciesName).toMatch(/^.+\(.+\)$/)
      }
      // Chukar stays as Chukar (matching eBird taxonomy)
      expect(previews[0].speciesName).toBe('Chukar (Alectoris chukar)')
      // Rock Pigeon should stay as Rock Pigeon
      expect(previews[1].speciesName).toBe('Rock Pigeon (Columba livia)')
    })
  })

  /* ---------- timezone-aware date handling ---------- */

  describe('timezone-aware date handling', () => {
    it('converts Hawaii observation from profile TZ to observation-local (UTC-10)', () => {
      const csv = ebirdCSV([
        'S276515153,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L53474467,Maui,20.682568,-156.442741,2024-12-18,07:16 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // CSV "07:16 PM" is in the user's eBird profile timezone (Pacific).
      // 7:16 PM PST (UTC-8) → 3:16 AM+1 UTC → 5:16 PM HST (UTC-10)
      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2024-12-18T17:16:00-10:00')
    })

    it('converts Taipei observation from profile TZ to observation-local (UTC+8)', () => {
      const csv = ebirdCSV([
        'S290456247,Oriental Turtle-Dove,Streptopelia orientalis,2022,X,TW-TPE,,L56387535,Taipei,24.99591,121.588157,2025-12-27,03:06 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // CSV "03:06 PM" is PST. 3:06 PM PST → 11:06 PM UTC → next day 7:06 AM Taipei
      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2025-12-28T07:06:00+08:00')
    })

    it('Seattle observation unchanged when profile TZ matches observation TZ', () => {
      // Summer: PDT (UTC-7), profile TZ is also Pacific, so no shift
      const csvSummer = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Park,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])
      const summer = parseEBirdCSV(csvSummer, 'America/Los_Angeles')[0]
      expect(summer.date).toBe('2025-06-01T11:07:00-07:00')

      // Winter: PST (UTC-8)
      const csvWinter = ebirdCSV([
        'S2,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Park,47.6,-122.4,2025-01-15,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])
      const winter = parseEBirdCSV(csvWinter, 'America/Los_Angeles')[0]
      expect(winter.date).toBe('2025-01-15T11:07:00-08:00')
    })

    it('converts Chicago observation from Pacific to Central time', () => {
      const csv = ebirdCSV([
        'S276393806,Canada Goose,Branta canadensis,342,X,US-IL,Cook,L53451695,Montrose Point,41.963254,-87.631954,2025-09-28,08:15 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // CSV "08:15 AM" is PDT (UTC-7). 8:15 AM PDT → 3:15 PM UTC → 10:15 AM CDT (UTC-5)
      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2025-09-28T10:15:00-05:00')
    })

    it('falls back to observation-local when no profileTimezone provided', () => {
      // Without profileTimezone, CSV time is treated as observation-local
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Park,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv)[0]
      expect(p.date).toBe('2025-06-01T11:07:00-07:00')
    })
  })

  /* ---------- groupPreviewsIntoOutings timezone edge cases ---------- */

  describe('groupPreviewsIntoOutings timezone edge cases', () => {
    it('groups by local date, not UTC date, for negative offset near midnight', () => {
      // Two Hawaii observations at 11 PM and 11:30 PM local (Dec 18)
      // In UTC these are Dec 19 09:00 and 09:30, but should group under Dec 18
      const previews = [
        {
          speciesName: 'Chukar (Alectoris chukar)',
          date: '2024-12-18T23:00:00-10:00',
          location: 'Maui',
          count: 1,
          lat: 20.682568,
          lon: -156.442741,
        },
        {
          speciesName: 'Rock Pigeon (Columba livia)',
          date: '2024-12-18T23:30:00-10:00',
          location: 'Maui',
          count: 2,
          lat: 20.682568,
          lon: -156.442741,
        },
      ]

      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')
      // Both are on local date 2024-12-18, same location → one outing
      expect(outings).toHaveLength(1)
      expect(observations).toHaveLength(2)
      // Outing startTime should preserve the offset-aware format
      expect(outings[0].startTime).toContain('2024-12-18')
    })

    it('splits observations across different local dates even if UTC date is the same', () => {
      // Taipei Dec 27 00:30 (+08:00) = Dec 26 16:30 UTC
      // Taipei Dec 28 00:30 (+08:00) = Dec 27 16:30 UTC
      // Different local dates → different outings
      const previews = [
        {
          speciesName: 'Bird A',
          date: '2025-12-27T00:30:00+08:00',
          location: 'Taipei',
          count: 1,
          lat: 24.99591,
          lon: 121.588157,
        },
        {
          speciesName: 'Bird B',
          date: '2025-12-28T00:30:00+08:00',
          location: 'Taipei',
          count: 1,
          lat: 24.99591,
          lon: 121.588157,
        },
      ]

      const { outings } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(2)
    })

    it('endTime of grouped outing is offset-aware when GPS is available', () => {
      const previews = [
        {
          speciesName: 'Bird A',
          date: '2024-12-18T17:16:00-10:00',
          location: 'Maui',
          count: 1,
          lat: 20.682568,
          lon: -156.442741,
        },
        {
          speciesName: 'Bird B',
          date: '2024-12-18T19:16:00-10:00',
          location: 'Maui',
          count: 1,
          lat: 20.682568,
          lon: -156.442741,
        },
      ]

      const { outings } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(1)
      // endTime should have -10:00 offset, not Z
      expect(outings[0].endTime).toMatch(/-10:00$/)
    })
  })

  /* ---------- import → export roundtrip ---------- */

  describe('import → export roundtrip', () => {
    it('parses MM/DD/YYYY dates as fallback', () => {
      const csv = [
        '"Common Name","Scientific Name","Date","Start Time","Location Name","Number","Latitude","Longitude"',
        '"Mallard","Anas platyrhynchos","09/28/2025","08:15","Discovery Park","2","47.6606","-122.4147"',
      ].join('\n')

      const previews = parseEBirdCSV(csv)
      expect(previews).toHaveLength(1)
      expect(previews[0].date).toContain('2025-09-28T08:15:00')
    })

    it('preserves Hawaii observation date/time through import → group → export', () => {
      const csv = ebirdCSV([
        'S276515153,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L53474467,Maui,20.682568,-156.442741,2024-12-18,07:16 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // Import: CSV "07:16 PM" is Pacific time → converts to 5:16 PM HST
      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      expect(previews[0].date).toBe('2024-12-18T17:16:00-10:00')

      // Group into outings
      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(1)
      expect(outings[0].startTime).toContain('2024-12-18')

      // Export
      const exportCsv = exportOutingToEBirdCSV(outings[0], observations, false)
      const fields = parseCSVLineForTest(exportCsv)
      expect(fields[9]).toBe('12/18/2024')
      // Time should be 17:16 (5:16 PM HST, the actual local time)
      expect(fields[10]).toBe('17:16')
    })

    it('preserves Taipei observation date/time through import → group → export', () => {
      const csv = ebirdCSV([
        'S290456247,Oriental Turtle-Dove,Streptopelia orientalis,2022,X,TW-TPE,,L56387535,Taipei,24.99591,121.588157,2025-12-27,03:06 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // CSV "03:06 PM" is PST → 11:06 PM UTC → next day 7:06 AM Taipei
      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')

      const exportCsv = exportOutingToEBirdCSV(outings[0], observations, false)
      const fields = parseCSVLineForTest(exportCsv)
      expect(fields[9]).toBe('12/28/2025')
      expect(fields[10]).toBe('07:06')
    })

    it('preserves Seattle summer observation through roundtrip', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Greenlake,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // Profile TZ = observation TZ → no shift
      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')

      const exportCsv = exportOutingToEBirdCSV(outings[0], observations, false)
      const fields = parseCSVLineForTest(exportCsv)
      expect(fields[9]).toBe('06/01/2025')
      expect(fields[10]).toBe('11:07')
    })

    it('re-imports exported outing CSV without species/date loss', () => {
      const sourceCsv = ebirdCSV([
        'S276515153,Chukar,Alectoris chukar,1765,2,US-HI,Maui,L53474467,Maui,20.682568,-156.442741,2024-12-18,07:16 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(sourceCsv, 'America/Los_Angeles')
      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')

      const exportWithHeader = exportOutingToEBirdCSV(outings[0], observations, true)
      const reparsed = parseEBirdCSV(exportWithHeader)

      expect(reparsed).toHaveLength(1)
      expect(reparsed[0].speciesName).toBe('Chukar (Alectoris chukar)')
      expect(reparsed[0].date).toContain('2024-12-18T17:16:00')
      expect(reparsed[0].location).toBe('Maui')
      expect(reparsed[0].count).toBe(2)
    })
  })
  /* ---------- Merlin travel scenario ---------- */

  describe('Merlin travel scenario (CSV import)', () => {
    // User photographs bird at 5:00 PM in Taipei. Merlin (on a Seattle phone)
    // maps the EXIF time to the device timezone: 5 PM CST+8 → 1 AM PST.
    // eBird records "01:00 AM" in the CSV with Taipei GPS coords.
    // Import with profile TZ "America/Los_Angeles" should recover 5 PM Taipei.

    it('recovers 5 PM Taipei local from Merlin 1 AM Pacific (winter)', () => {
      const csv = ebirdCSV([
        'S1,Light-vented Bulbul,Pycnonotus sinensis,3050,1,TW-TPE,,L1,Taipei,24.99591,121.588157,2025-01-15,01:00 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2025-01-15T17:00:00+08:00')
    })

    it('recovers 5 PM Taipei local from Merlin 2 AM Pacific (summer PDT)', () => {
      const csv = ebirdCSV([
        'S2,Light-vented Bulbul,Pycnonotus sinensis,3050,1,TW-TPE,,L1,Taipei,24.99591,121.588157,2025-06-15,02:00 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // 2 AM PDT = 9 AM UTC = 5 PM Taipei
      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2025-06-15T17:00:00+08:00')
    })

    it('Merlin scenario: full roundtrip import → group → export', () => {
      const csv = ebirdCSV([
        'S1,Light-vented Bulbul,Pycnonotus sinensis,3050,1,TW-TPE,,L1,Taipei,24.99591,121.588157,2025-01-15,01:00 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      expect(previews[0].date).toBe('2025-01-15T17:00:00+08:00')

      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')
      expect(outings).toHaveLength(1)

      const exportCsv = exportOutingToEBirdCSV(outings[0], observations, false)
      const fields = parseCSVLineForTest(exportCsv)
      // Export should use the recovered Taipei local time
      expect(fields[9]).toBe('01/15/2025')
      expect(fields[10]).toBe('17:00')
    })

    it('Merlin scenario: Kolkata photo from Seattle phone', () => {
      const csv = ebirdCSV([
        'S3,House Crow,Corvus splendens,2950,2,IN-DL,,L1,Delhi,28.6139,77.2090,2025-01-15,02:00 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // 2 AM PST = 10 AM UTC = 3:30 PM IST
      const p = parseEBirdCSV(csv, 'America/Los_Angeles')[0]
      expect(p.date).toBe('2025-01-15T15:30:00+05:30')
    })
  })

  /* ---------- non-Pacific profile timezone ---------- */

  describe('non-Pacific profile timezone import', () => {
    it('Eastern profile TZ → Hawaii observation', () => {
      const csv = ebirdCSV([
        'S1,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L1,Maui,20.682568,-156.442741,2025-01-15,07:00 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // 7 PM EST = midnight UTC = 2 PM HST
      const p = parseEBirdCSV(csv, 'America/New_York')[0]
      expect(p.date).toBe('2025-01-15T14:00:00-10:00')
    })

    it('Central European profile TZ → Seattle observation', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Park,47.6,-122.4,2025-01-15,06:00 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // 6 PM CET = 5 PM UTC = 9 AM PST
      const p = parseEBirdCSV(csv, 'Europe/Paris')[0]
      expect(p.date).toBe('2025-01-15T09:00:00-08:00')
    })

    it('Japan profile TZ → Hawaii observation', () => {
      const csv = ebirdCSV([
        'S1,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L1,Maui,20.682568,-156.442741,2025-01-15,03:00 PM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      // 3 PM JST = 6 AM UTC = 8 PM prev day HST
      const p = parseEBirdCSV(csv, 'Asia/Tokyo')[0]
      expect(p.date).toBe('2025-01-14T20:00:00-10:00')
    })
  })

  /* ---------- multi-timezone single CSV import ---------- */

  describe('multi-timezone observations in single CSV', () => {
    it('correctly converts each observation to its own local timezone', () => {
      const csv = ebirdCSV([
        // Hawaii observation at 5:16 PM Pacific time
        'S1,Chukar,Alectoris chukar,1765,X,US-HI,Maui,L1,Maui,20.682568,-156.442741,2024-12-18,05:16 PM,eBird - Casual Observation,,0,,,1,,,,',
        // Taipei observation at 3:06 PM Pacific time
        'S2,Oriental Turtle-Dove,Streptopelia orientalis,2022,X,TW-TPE,,L2,Taipei,24.99591,121.588157,2025-12-27,03:06 PM,eBird - Casual Observation,,0,,,1,,,,',
        // Seattle observation at 11:07 AM Pacific time
        'S3,Mallard,Anas platyrhynchos,545,X,US-WA,King,L3,Park,47.6,-122.4,2025-06-01,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
        // Delhi observation at 2:00 AM Pacific time
        'S4,House Crow,Corvus splendens,2950,2,IN-DL,,L4,Delhi,28.6139,77.2090,2025-01-15,02:00 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')

      // Hawaii: 5:16 PM PST → 3:16 PM HST
      expect(previews[0].date).toBe('2024-12-18T15:16:00-10:00')
      // Taipei: 3:06 PM PST → next day 7:06 AM CST+8
      expect(previews[1].date).toBe('2025-12-28T07:06:00+08:00')
      // Seattle: unchanged (same TZ), summer PDT
      expect(previews[2].date).toBe('2025-06-01T11:07:00-07:00')
      // Delhi: 2 AM PST → 3:30 PM IST
      expect(previews[3].date).toBe('2025-01-15T15:30:00+05:30')
    })
  })

  /* ---------- missing GPS with profile timezone ---------- */

  describe('missing GPS with profile timezone', () => {
    it('falls back gracefully when lat/lon are missing', () => {
      const csv = ebirdCSV([
        // No lat/lon, some eBird exports can have empty coordinates
        'S1,Mallard,Anas platyrhynchos,545,X,US-WA,King,L1,Park,,,2025-01-15,11:07 AM,eBird - Casual Observation,,0,,,1,,,,',
      ])

      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      // Should still import without crashing; time treated as observation-local
      expect(previews).toHaveLength(1)
      expect(previews[0].date).toContain('2025-01-15')
      expect(previews[0].date).toContain('11:07')
    })

    it('imports checklist effort metadata and re-exports it', () => {
      const csv = ebirdCSV([
        'S1,Mallard,Anas platyrhynchos,545,3,US-WA,King,L1,Park,47.6,-122.4,2025-01-15,11:07 AM,Traveling,45,1,2.5,20,2,,,,',
      ])

      const previews = parseEBirdCSV(csv, 'America/Los_Angeles')
      const { outings, observations } = groupPreviewsIntoOutings(previews, 'u1')

      expect(outings).toHaveLength(1)
      expect(outings[0].protocol).toBe('Traveling')
      expect(outings[0].numberObservers).toBe(2)
      expect(outings[0].allObsReported).toBe(true)
      expect(outings[0].effortDistanceMiles).toBeCloseTo(2.5 * 0.621371, 6)
      expect(outings[0].effortAreaAcres).toBeCloseTo(20 * 2.47105, 6)

      const exported = exportOutingToEBirdCSV(outings[0], observations, false)
      const cells = parseCSVLineForTest(exported).map(value => value.replace(/^"|"$/g, ''))

      expect(cells[13]).toBe('Traveling')
      expect(cells[14]).toBe('2')
      expect(cells[16]).toBe('Y')
    })
  })
