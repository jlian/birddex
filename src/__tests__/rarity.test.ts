import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { parseRarity, rarityAt, ordinaryMonths, type RarityState } from '@/lib/rarity'
import { lonLatToEqualEarth, xyToCell, GRID_COLS } from '@/lib/equal-earth'

const TAX_HASH = '04951673b96b11bf'
const SHIPPED = 'public/priors/rarity.2c02a406.bin.gz'

/** Encode one WDRR asset in memory. Mirrors ml/distill/build_rarity_blob.py. */
function buildAsset(opts: {
  coarse?: number
  taxHash?: string
  cells: { key: number; monthMask: number; species: [number, number][] }[]
}): Uint8Array {
  const coarse = opts.coarse ?? 4
  const cells = [...opts.cells].sort((a, b) => a.key - b.key)

  const payload: number[] = []
  const index: [number, number][] = []
  for (const cell of cells) {
    index.push([cell.key, payload.length])
    let prev = 0
    for (const [idx, mask] of [...cell.species].sort((a, b) => a[0] - b[0])) {
      let d = idx - prev
      prev = idx
      while (d >= 0x80) {
        payload.push((d & 0x7f) | 0x80)
        d >>>= 7
      }
      payload.push(d)
      payload.push(mask & 0xff, (mask >> 8) & 0xff)
    }
  }

  const out = new Uint8Array(20 + (cells.length + 1) * 8 + cells.length * 2 + payload.length)
  const view = new DataView(out.buffer)
  out.set([0x57, 0x44, 0x52, 0x52], 0) // "WDRR"
  out[4] = 1
  out[5] = coarse
  const hash = opts.taxHash ?? TAX_HASH
  for (let i = 0; i < 8; i++) out[8 + i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16)
  view.setUint32(16, cells.length, true)

  let p = 20
  for (const [key, off] of index) {
    view.setUint32(p, key, true)
    view.setUint32(p + 4, off, true)
    p += 8
  }
  view.setUint32(p, 0xffffffff, true)
  view.setUint32(p + 4, payload.length, true)
  p += 8
  for (const cell of cells) {
    view.setUint16(p, cell.monthMask, true)
    p += 2
  }
  out.set(payload, p)
  return out
}

const ALL_MONTHS = 0xfff

/** A point whose coarse key is `key` at coarsening 4, found by inversion. */
function pointForKey(key: number, coarse = 4): { lat: number; lon: number } {
  for (let lat = 60; lat > -60; lat -= 0.5) {
    for (let lon = -180; lon < 180; lon += 0.5) {
      const { x, y } = lonLatToEqualEarth(lon, lat)
      const cell = xyToCell(x, y)
      if (!cell) continue
      const coarseCols = Math.ceil(GRID_COLS / coarse)
      const k = Math.floor(cell.row / coarse) * coarseCols + Math.floor(cell.col / coarse)
      if (k === key) return { lat, lon }
    }
  }
  throw new Error('no point maps to coarse key ' + key)
}

describe('rarity asset parsing', () => {
  it('rejects a bad magic', () => {
    const a = buildAsset({ cells: [] })
    a[0] = 0x58
    expect(() => parseRarity(a)).toThrow(/bad magic/)
  })

  it('rejects a taxonomy hash mismatch rather than mis-keying every verdict', () => {
    const a = buildAsset({ cells: [], taxHash: 'ffffffffffffffff' })
    expect(() => parseRarity(a, TAX_HASH)).toThrow(/taxonomy hash/)
  })

  it('rejects a truncated asset instead of decoding garbage', () => {
    const a = buildAsset({
      cells: [{ key: 10, monthMask: ALL_MONTHS, species: [[5, ALL_MONTHS]] }],
    })
    expect(() => parseRarity(a.slice(0, 24))).toThrow(/truncated|too short/)
  })
})

describe('rarityAt', () => {
  const KEY = 5000
  const pt = pointForKey(KEY)

  const asset = (species: [number, number][], monthMask = ALL_MONTHS) =>
    parseRarity(buildAsset({ cells: [{ key: KEY, monthMask, species }] }))

  const at = (species: [number, number][], idx: number, month: number,
              monthMask = ALL_MONTHS): RarityState =>
    rarityAt(asset(species, monthMask), idx, pt.lat, pt.lon, month)

  it('marks nothing for a species ordinary this month', () => {
    expect(at([[7, ALL_MONTHS]], 7, 6)).toBe('none')
  })

  it('marks out of season when the species is ordinary in another month', () => {
    // Ordinary November through February only. A June record is the Snowy Owl case.
    const winter = (1 << 10) | (1 << 11) | (1 << 0) | (1 << 1)
    expect(at([[7, winter]], 7, 6)).toBe('outOfSeason')
    expect(at([[7, winter]], 7, 12)).toBe('none')
  })

  it('marks off range when the species is recorded but ordinary in no month', () => {
    expect(at([[7, 0]], 7, 6)).toBe('offRange')
  })

  it('marks both when the species is absent from a cell that has records', () => {
    expect(at([[7, ALL_MONTHS]], 99, 6)).toBe('both')
  })

  it('marks nothing when the cell is absent, because no data is not rare', () => {
    const other = pointForKey(KEY + 40)
    const a = asset([[7, ALL_MONTHS]])
    expect(rarityAt(a, 99, other.lat, other.lon, 6)).toBe('none')
  })

  it('marks nothing for a month the cell cannot judge', () => {
    // Only June is judgeable, so a December sighting is unknown, not rare.
    expect(at([[7, 1 << 5]], 99, 12, 1 << 5)).toBe('none')
    expect(at([[7, 1 << 5]], 99, 6, 1 << 5)).toBe('both')
  })

  it('marks nothing for an invalid month rather than reading January', () => {
    const a = asset([[7, ALL_MONTHS]])
    for (const m of [0, 13, NaN, 6.5, Infinity]) {
      expect(rarityAt(a, 99, pt.lat, pt.lon, m)).toBe('none')
    }
  })

  it('marks nothing for a point off the grid or a bad species index', () => {
    const a = asset([[7, ALL_MONTHS]])
    expect(rarityAt(a, 99, NaN, NaN, 6)).toBe('none')
    expect(rarityAt(a, -1, pt.lat, pt.lon, 6)).toBe('none')
  })

  it('finds a species that sorts after others in the same cell', () => {
    const species: [number, number][] = [[3, ALL_MONTHS], [400, 0], [9000, ALL_MONTHS]]
    expect(at(species, 400, 6)).toBe('offRange')
    expect(at(species, 9000, 6)).toBe('none')
    expect(at(species, 8999, 6)).toBe('both')
  })

  it('marks nothing when the payload is corrupt, never a mega', () => {
    // "Absent from a well-recorded cell" is the STRONGEST verdict this asset
    // gives, so a truncated payload that merely looks absent would turn a bad
    // download into a screen full of confident megas. Corruption fails closed.
    const raw = buildAsset({
      cells: [{ key: KEY, monthMask: ALL_MONTHS, species: [[7, ALL_MONTHS], [9000, 0]] }],
    })
    const blob = parseRarity(raw)
    // Chop the payload so the offsets promise more bytes than exist.
    const truncated = parseRarity(raw.slice(0, raw.length - 3))
    expect(rarityAt(blob, 500, pt.lat, pt.lon, 6)).toBe('both')
    expect(rarityAt(truncated, 500, pt.lat, pt.lon, 6)).toBe('none')
  })
})

describe('ordinaryMonths', () => {
  const KEY = 5000
  const pt = pointForKey(KEY)

  it('reports the months a species is ordinary here', () => {
    const winter = (1 << 10) | (1 << 11) | (1 << 0)
    const a = parseRarity(buildAsset({
      cells: [{ key: KEY, monthMask: ALL_MONTHS, species: [[7, winter]] }],
    }))
    expect(ordinaryMonths(a, 7, pt.lat, pt.lon)).toEqual([
      true, false, false, false, false, false,
      false, false, false, false, true, true,
    ])
  })

  it('returns null for a cell with no data, not twelve false bars', () => {
    const other = pointForKey(KEY + 40)
    const a = parseRarity(buildAsset({
      cells: [{ key: KEY, monthMask: ALL_MONTHS, species: [[7, ALL_MONTHS]] }],
    }))
    expect(ordinaryMonths(a, 7, other.lat, other.lon)).toBeNull()
  })

  it('never reports a month the cell cannot judge as ordinary', () => {
    const a = parseRarity(buildAsset({
      cells: [{ key: KEY, monthMask: 1 << 5, species: [[7, ALL_MONTHS]] }],
    }))
    expect(ordinaryMonths(a, 7, pt.lat, pt.lon)).toEqual(
      Array.from({ length: 12 }, (_, m) => m === 5))
  })
})

describe('the shipped asset', () => {
  const blob = parseRarity(gunzipSync(readFileSync(SHIPPED)), TAX_HASH)

  it('parses with the taxonomy hash the app ships', () => {
    expect(blob.version).toBe(1)
    expect(blob.coarse).toBe(4)
    expect(blob.nCells).toBeGreaterThan(1000)
  })

  it('stays small enough to fetch without a download gate', () => {
    expect(readFileSync(SHIPPED).length).toBeLessThan(4 * 1024 * 1024)
  })

  it('says nothing at all in the middle of the Pacific', () => {
    expect(rarityAt(blob, 7, -30, -140, 6)).toBe('none')
  })
})
