/**
 * Rarity verdicts read from public/priors/rarity.<hash>.bin.gz.
 *
 * Answers one question: is this species notable HERE, THIS MONTH. It is a
 * separate asset from the occurrence prior on purpose. The v4 prior is
 * 22.62 MiB gzipped and the web client only fetches it behind
 * ModelDownloadGate on the first identify, but a rarity mark has to render on
 * the WingDex and Outings pages where that blob is not present. This asset is
 * 1.38 MiB because it carries a 12-bit verdict per (species, cell) instead of
 * a 5-bit log-probability per (species, cell, month), on a grid coarsened 4x.
 *
 * Format, little-endian, deliberately shaped like WDOP so the two decoders
 * read alike: "WDRR" magic, version, coarsening factor, 2 reserved bytes, an
 * 8-byte taxonomy hash, n_cells, a sorted (key, offset) index of 8-byte pairs
 * with a sentinel, a uint16-per-cell month mask table parallel to the index,
 * then a payload of varint species-index deltas each followed by a uint16
 * ordinary-month mask.
 *
 * Species are keyed by ROW INDEX into taxonomy.json, exactly as in WDOP, so
 * the taxonomy hash is checked and a mismatch throws rather than silently
 * mis-keying every verdict.
 *
 * NO THRESHOLDS LIVE HERE. Every cut was applied by ml/distill/build_rarity_blob.py
 * where the full record counts still existed. A constant on this side would be
 * a second place for the web and iOS ports to disagree.
 */

import { GRID_COLS, lonLatToEqualEarth, xyToCell } from './equal-earth'

export const RARITY_MAGIC = 'WDRR'

/**
 * The shipped asset, named by the content hash of its bytes so a rebuild can
 * never be served from a stale immutable cache entry. This is the ONE place
 * the filename lives: ios/scripts/sync-birdid-assets.sh greps it out of this
 * module to stage the same bytes into the app bundle.
 *
 * Deliberately NOT in MODEL_ASSET_URLS. Those four assets total 56.39 MiB and
 * sit behind ModelDownloadGate because most visits never identify a bird. This
 * one is 1.38 MiB and is fetched eagerly wherever a list of birds renders, so
 * folding it into that gate would both delay the mark and inflate the gated
 * download for no reason.
 */
export const RARITY_ASSET_URL = '/priors/rarity.2c02a406.bin.gz'

/**
 * Why a bird is notable, or that it is not.
 *
 * `offRange` and `outOfSeason` are independent readings, and `both` is the
 * genuine vagrant: never meaningfully recorded in a cell that has plenty of
 * records. Measured frequencies on the shipped asset are 1 row in 22, 1 in 66
 * and 1 in 208.
 */
export type RarityState = 'none' | 'outOfSeason' | 'offRange' | 'both'

export type RarityBlob = {
  raw: Uint8Array
  view: DataView
  nCells: number
  idxStart: number
  monthsStart: number
  payloadStart: number
  coarse: number
  coarseCols: number
  version: number
  taxHash: string
}

const HEADER_BYTES = 20

/**
 * Parse the decompressed asset. Pass the taxonomy hash to verify keying; omit
 * it only in offline tooling that has already checked.
 */
export function parseRarity(raw: Uint8Array, taxonomySha16?: string): RarityBlob {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  // Check the length before reading any header field. Out-of-range indexing
  // yields undefined, so a truncated asset otherwise reports "bad magic NaN"
  // rather than saying what is actually wrong. The Swift port guards the same.
  if (raw.length < HEADER_BYTES) {
    throw new Error('rarity asset too short: ' + raw.length + ' bytes')
  }
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
  if (magic !== RARITY_MAGIC) throw new Error('rarity asset: bad magic ' + magic)

  const version = raw[4]
  const coarse = raw[5]
  if (coarse < 1) throw new Error('rarity asset: bad coarsening factor ' + coarse)

  let taxHash = ''
  for (let i = 8; i < 16; i++) taxHash += raw[i].toString(16).padStart(2, '0')
  if (taxonomySha16 && taxonomySha16 !== taxHash) {
    throw new Error(
      'rarity asset taxonomy hash ' + taxHash + ' != taxonomy.json ' +
      taxonomySha16 + ' -- rebuild the asset',
    )
  }

  const nCells = view.getUint32(16, true)
  const idxStart = HEADER_BYTES
  const monthsStart = idxStart + (nCells + 1) * 8
  const payloadStart = monthsStart + nCells * 2

  // Bounds-check the header before trusting it. Magic, version and taxonomy
  // hash all live in the first 16 bytes, so an asset truncated AFTER that
  // still passes every check above and the varint reader would then walk off
  // the end, where raw[p++] is undefined and `undefined & 0x7f` is 0, so the
  // loop exits quietly and returns a confident wrong verdict.
  if (payloadStart > raw.length) {
    throw new Error(
      'rarity asset truncated: index needs ' + payloadStart +
      ' bytes but the asset is ' + raw.length,
    )
  }

  return {
    raw, view, nCells, idxStart, monthsStart, payloadStart,
    coarse, coarseCols: Math.ceil(GRID_COLS / coarse), version, taxHash,
  }
}

/** Binary-search the index for an exact key. Returns the ARRAY POSITION,
 *  because the month table is parallel to the index and needs that position. */
function findSlot(r: RarityBlob, want: number): number {  let lo = 0
  let hi = r.nCells - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const key = r.view.getUint32(r.idxStart + mid * 8, true)
    if (key === want) return mid
    if (key < want) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** The coarse cell key for a point, or -1 when it falls outside the grid,
 *  which is a real case: the Equal Earth box includes ocean no cell covers. */
function coarseKey(r: RarityBlob, lat: number, lon: number): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1
  const { x, y } = lonLatToEqualEarth(lon, lat)
  const cell = xyToCell(x, y)
  if (!cell) return -1
  return Math.floor(cell.row / r.coarse) * r.coarseCols +
         Math.floor(cell.col / r.coarse)
}

/**
 * The outcome of looking one species up inside a cell.
 *
 * `absent` and `invalid` MUST stay distinct. Absent is the strongest verdict
 * this asset can give, a bird never recorded in a well-recorded cell, so
 * collapsing a corrupt payload into it would turn a truncated download into a
 * screen full of confident megas. Corruption has to fail closed.
 */
type MaskLookup =
  | { kind: 'found'; mask: number }
  | { kind: 'absent' }
  | { kind: 'invalid' }

/** Walk one cell's payload for a single species. */
function findMask(r: RarityBlob, slot: number, speciesIdx: number): MaskLookup {
  const start = r.view.getUint32(r.idxStart + slot * 8 + 4, true)
  const end = r.view.getUint32(r.idxStart + (slot + 1) * 8 + 4, true)
  let p = r.payloadStart + start
  const stop = r.payloadStart + end
  if (start > end || stop > r.raw.length) return { kind: 'invalid' }
  let cur = 0
  while (p < stop) {
    let shift = 0
    let v = 0
    let b = 0
    do {
      // The shift cap is not padding. JS shift counts are taken mod 32, so a
      // malformed sixth byte wraps to shift 3 and corrupts `cur` upward, which
      // can step past the target and return a clean-looking `absent` that the
      // caller renders as a mega. The Swift port guards the same way.
      if (p >= stop || shift >= 35) return { kind: 'invalid' }
      b = r.raw[p++]
      v |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    cur += v
    if (p + 1 >= stop) return { kind: 'invalid' }
    const mask = r.raw[p] | (r.raw[p + 1] << 8)
    p += 2
    if (cur === speciesIdx) return { kind: 'found', mask }
    // Species are stored ascending, so passing the target means it is absent.
    if (cur > speciesIdx) return { kind: 'absent' }
  }
  return { kind: 'absent' }
}

/**
 * The verdict for one species at one place in one month, keyed by taxonomy row
 * index. `month` is 1-12.
 *
 * Returns 'none' for anything unknown, and that conflation is deliberate: an
 * undersampled cell, a month with too few records, a point off the grid and a
 * genuinely ordinary bird must all render as no mark. A false rare on every
 * bird in an under-recorded region is worse than showing nothing.
 */
export function rarityAt(
  r: RarityBlob,
  speciesIdx: number,
  lat: number,
  lon: number,
  month: number,
): RarityState {
  if (!Number.isInteger(speciesIdx) || speciesIdx < 0) return 'none'
  // Number.isInteger is doing real work: NaN passes every comparison below,
  // and `1 << (NaN - 1)` is 1, which would silently read January's bit for a
  // photo with the standard EXIF null date. See the same note in occurrence.ts.
  if (!Number.isInteger(month) || month < 1 || month > 12) return 'none'

  const key = coarseKey(r, lat, lon)
  if (key < 0) return 'none'

  const slot = findSlot(r, key)
  // Cell absent means undersampled. NOT rare.
  if (slot < 0) return 'none'

  const monthMask = r.view.getUint16(r.monthsStart + slot * 2, true)
  // This cell has too few records in this month to judge anything.
  if (!((monthMask >> (month - 1)) & 1)) return 'none'

  const found = findMask(r, slot, speciesIdx)
  // A corrupt payload marks nothing. Only a clean miss is the mega.
  if (found.kind === 'invalid') return 'none'
  if (found.kind === 'absent') return 'both'
  if ((found.mask >> (month - 1)) & 1) return 'none'
  return found.mask === 0 ? 'offRange' : 'outOfSeason'
}

/**
 * The 12 months in which this species is ordinary here, for the seasonal
 * readout on species detail. Index 0 is January. Null when the cell carries no
 * usable data, which must render as "not enough records" rather than as a bird
 * that belongs in no month at all.
 */
export function ordinaryMonths(
  r: RarityBlob,
  speciesIdx: number,
  lat: number,
  lon: number,
): boolean[] | null {
  if (!Number.isInteger(speciesIdx) || speciesIdx < 0) return null
  const key = coarseKey(r, lat, lon)
  if (key < 0) return null
  const slot = findSlot(r, key)
  if (slot < 0) return null
  const monthMask = r.view.getUint16(r.monthsStart + slot * 2, true)
  if (monthMask === 0) return null
  const found = findMask(r, slot, speciesIdx)
  if (found.kind === 'invalid') return null
  const mask = found.kind === 'found' ? found.mask : 0
  // A month the cell cannot judge reads as not-ordinary rather than as a gap,
  // because the caller draws 12 bars and a third state has no meaning there.
  return Array.from({ length: 12 }, (_, m) =>
    ((monthMask >> m) & 1) === 1 && ((mask >> m) & 1) === 1)
}
