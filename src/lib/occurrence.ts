/**
 * Empirical P(species|cell) read from public/priors/occurrence.<hash>.bin.gz.
 *
 * Ported from ml/scripts/pipeline-experiment.mjs, which decodes the blob
 * exactly as the client must. Kept as a straight port rather than a rewrite so
 * the offline harness and the shipping client cannot drift.
 *
 * Format: "WDOP" magic, version, qbits, then for v2 and later an 8-byte
 * taxonomy hash, then n_cells, then a sorted (key, offset) index of 8-byte
 * pairs, then a payload of varint species-index deltas each followed by one
 * quantised byte.
 *
 * v2 keys the index by cell and stores P(species|cell).
 * v3 keys it by (cell << 4) | (month - 1) and stores P(species|cell,month),
 * which is worth +1.2 points of top-1 accuracy. The month axis multiplies the
 * slice count but the blob still gzips to 15.7 MiB, inside the 25 MiB cap.
 * v4 adds two things v3 discarded, so the client can apply backoff:
 *   - a POOLED slice per cell holding P(species|cell), under the reserved
 *     month code 12 (months use 0..11, so 12..15 are free);
 *   - n_cm per index entry, in a uint32 table parallel to the index, inserted
 *     between the index and the payload.
 * Because v3 stores only the NORMALISED ratio n_scm / n_cm, n_cm is divided
 * out and unrecoverable, so no Dirichlet-multinomial backoff can be applied
 * against a v3 blob at all. v4 stores the denominator instead of baking a
 * chosen k into the probabilities, which keeps k a client constant that can be
 * retuned without rebuilding and re-downloading the asset.
 *
 * Species are keyed by ROW INDEX into taxonomy.json. A reordered taxonomy
 * would silently mis-key every prior, so the taxonomy hash is checked and a
 * mismatch throws rather than degrading quietly.
 */

import { GRID_COLS } from './equal-earth'

// equal-earth.ts owns the grid geometry. Re-exported rather than redeclared so
// the two cannot drift: a mismatched column count silently mis-keys every cell.
export { GRID_COLS }
export const OCC_SCALE = 2.5
/** v3 packs month into the low bits of the index key. */
export const MONTH_BITS = 4
/**
 * v4 pooled per-cell slice. Months are stored as (month - 1), so the 4-bit
 * field only ever holds 0..11 and 12 is unused. Reusing the month field rather
 * than adding a second index means the pooled slice is found by the SAME
 * binary search, with no extra table and no branch in the hot path.
 */
export const POOLED_MONTH_CODE = 12

export type OccBlob = {
  raw: Uint8Array
  view: DataView
  nCells: number
  idxStart: number
  payloadStart: number
  /** v4 only: byte offset of the uint32-per-index-entry n_cm table. */
  totalsStart: number
  qbits: number
  scale: number
  version: number
  taxHash: string | null
}

/**
 * Parse the decompressed blob. Pass the taxonomy hash to verify keying;
 * omit it only in offline tooling that has already checked.
 */
export function parseOccurrence(raw: Uint8Array, taxonomySha16?: string): OccBlob {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  // Check the length before reading any header field. Out-of-range indexing
  // yields undefined, so a truncated blob otherwise reports "bad magic NaN" or
  // throws on undefined.toString rather than saying what is actually wrong.
  // The Swift port guards the same way.
  if (raw.length < 6) {
    throw new Error("occurrence blob too short: " + raw.length + " bytes")
  }
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
  if (magic !== "WDOP") throw new Error("occurrence blob: bad magic " + magic)
  const version = raw[4]
  const qbits = raw[5]
  const hashLen = version >= 2 ? 8 : 0
  if (raw.length < 12 + hashLen) {
    throw new Error("occurrence blob too short: " + raw.length +
                    " bytes, need " + (12 + hashLen))
  }

  let taxHash: string | null = null
  if (version >= 2) {
    let s = ""
    for (let i = 8; i < 16; i++) s += raw[i].toString(16).padStart(2, "0")
    taxHash = s
    if (taxonomySha16 && taxonomySha16 !== taxHash) {
      throw new Error(
        "occurrence blob taxonomy hash " + taxHash + " != taxonomy.json " +
        taxonomySha16 + " -- rebuild the blob",
      )
    }
  }

  const nCells = view.getUint32(8 + hashLen, true)
  const idxStart = 12 + hashLen
  // v4 inserts the totals table between the index and the payload. Deriving
  // both offsets from the same expression keeps the two versions from drifting
  // by a table width, which would decode the payload at a shifted offset and
  // return plausible garbage rather than throwing.
  const totalsStart = idxStart + (nCells + 1) * 8
  const totalsBytes = version >= 4 ? nCells * 4 : 0
  const payloadStart = totalsStart + totalsBytes

  // Bounds-check the header before trusting it. The magic, version and
  // taxonomy hash all live in the first 16 bytes, so a blob truncated AFTER
  // that still passes every existing check. The varint reader would then walk
  // off the end, where `raw[p++]` is undefined, `undefined & 0x7f` is 0 so the
  // loop exits quietly, and the dequantised value becomes NaN. That NaN flows
  // into the score and poisons the sort, which is the silent-wrong-answer
  // failure this parser exists to prevent.
  if (payloadStart > raw.length) {
    throw new Error(
      "occurrence blob truncated: index needs " + payloadStart +
      " bytes but the blob is " + raw.length,
    )
  }

  return { raw, view, nCells, idxStart, totalsStart, payloadStart, qbits,
           scale: OCC_SCALE, version, taxHash }
}

/**
 * Binary-search the index for an exact key. Returns the ARRAY POSITION, not
 * the payload offset, because v4's totals table is parallel to the index and
 * needs that position to find n_cm without a second search.
 */
function findSlot(o: OccBlob, want: number): number {
  let lo = 0
  let hi = o.nCells - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const key = o.view.getUint32(o.idxStart + mid * 8, true)
    if (key === want) return mid
    if (key < want) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** Decode the payload run at an index position into species -> log p. */
function decodeSlot(o: OccBlob, slot: number): Map<number, number> | null {
  const start = o.view.getUint32(o.idxStart + slot * 8 + 4, true)
  const end = o.view.getUint32(o.idxStart + (slot + 1) * 8 + 4, true)
  const out = new Map<number, number>()
  let p = o.payloadStart + start
  const stop = o.payloadStart + end
  // A corrupt offset pair would send the reader off the end, where raw[p++] is
  // undefined, `undefined & 0x7f` is 0 so the varint loop exits quietly, and
  // the dequantised value becomes NaN. That NaN poisons the sort, which is the
  // silent-wrong-answer failure this parser exists to prevent.
  if (start > end || stop > o.raw.length) return null
  let cur = 0
  while (p < stop) {
    let shift = 0
    let v = 0
    let b = 0
    do {
      if (p >= stop) return out
      b = o.raw[p++]
      v |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    cur += v
    if (p >= stop) return out
    const q = o.raw[p++]
    out.set(cur, -q / o.scale)
  }
  return out
}

/** True when `month` is a usable 1-12 integer. See the NaN note in occCell. */
function validMonth(month: number | undefined): month is number {
  return month !== undefined && Number.isInteger(month) &&
         month >= 1 && month <= 12
}

/**
 * Log P(species|cell) for one cell, keyed by taxonomy row index.
 * Returns null when the cell carries no data, which the caller must treat as
 * "fall back to vision only" rather than as zero probability.
 */
export function occCell(
  o: OccBlob,
  row: number,
  col: number,
  month?: number,
): Map<number, number> | null {
  // v3 slices by (cell, month); v2 slices by cell alone. Reading a v3 blob
  // without a month, or a v2 blob with one, would silently look up the wrong
  // key and return a plausible but wrong prior, so the version decides.
  let want: number
  if (o.version >= 3) {
    // Number.isInteger is doing real work here, not defensive padding: NaN
    // passes every comparison below (NaN < 1 and NaN > 12 are both FALSE), and
    // the key expression ends in `| (month - 1)`, where bitwise-OR coerces NaN
    // to 0. A NaN month therefore produced the exact same key as January and
    // applied January's distribution to, say, an August photo, silently
    // reordering candidates instead of degrading to vision-only.
    // Reachable: `new Date("0000:00:00 00:00:00")` is the standard EXIF null
    // date and getMonth() on it is NaN.
    if (!validMonth(month)) return null
    want = ((row * GRID_COLS + col) << MONTH_BITS) | (month - 1)
  } else {
    want = row * GRID_COLS + col
  }
  const slot = findSlot(o, want)
  if (slot < 0) return null
  return decodeSlot(o, slot)
}

/**
 * v4 only: the month-agnostic P(species|cell) slice, for backoff. Returns null
 * for v3 and earlier, which do not carry one, and for a cell with no data.
 */
export function occCellPooled(
  o: OccBlob,
  row: number,
  col: number,
): Map<number, number> | null {
  if (o.version < 4) return null
  const want = ((row * GRID_COLS + col) << MONTH_BITS) | POOLED_MONTH_CODE
  const slot = findSlot(o, want)
  if (slot < 0) return null
  return decodeSlot(o, slot)
}

/**
 * v4 only: n_cm, the total observation count backing a cell-month slice, or
 * n_c when `month` is omitted. This is the denominator v3 divided out and
 * discarded. Returns null when unavailable, which the caller must treat as
 * "cannot apply backoff" rather than as a count of zero: zero would make the
 * backoff term (0 + k*P) / (0 + k) = P, silently replacing the monthly prior
 * with the pooled one instead of falling back to the v3 behaviour.
 */
export function occTotal(
  o: OccBlob,
  row: number,
  col: number,
  month?: number,
): number | null {
  if (o.version < 4) return null
  const cell = row * GRID_COLS + col
  let want: number
  if (month === undefined) {
    want = (cell << MONTH_BITS) | POOLED_MONTH_CODE
  } else {
    if (!validMonth(month)) return null
    want = (cell << MONTH_BITS) | (month - 1)
  }
  const slot = findSlot(o, want)
  if (slot < 0) return null
  return o.view.getUint32(o.totalsStart + slot * 4, true)
}

// NOTE: do NOT add a lat/lon to cell helper here. The grid is an equal-area
// projection, not a naive lat/lon division. equal-earth.ts owns
// that math (lonLatToGrid / GRID_ORIGIN / GRID_CELL_SIZE) and is already shared
// by the offline harness. Reimplementing it would silently mis-key every
// lookup for the same reason the taxonomy hash exists.
