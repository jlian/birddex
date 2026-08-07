import { describe, it, expect } from 'vitest'
import { occCell, parseOccurrence, GRID_COLS, MONTH_BITS } from '../lib/occurrence'

/**
 * The month guard, and why NaN is the case that matters.
 *
 * The v3 prior is keyed by (cell, month) and the key is built as
 *   ((row * GRID_COLS + col) << MONTH_BITS) | (month - 1)
 * A NaN month passes every range comparison, because NaN < 1 and NaN > 12 are
 * BOTH false, and bitwise-OR then coerces NaN to 0. So NaN produced exactly
 * the same key as January and applied January's species distribution to a
 * photo from any month, silently reordering candidates.
 *
 * Reachable from real photos: "0000:00:00 00:00:00" is the standard EXIF null
 * timestamp, and new Date() on it yields Invalid Date whose getMonth() is NaN.
 *
 * A wrong prior is worse than no prior. Without a month the ranker falls back
 * to vision-only, which is honest. With January's prior it is confidently
 * wrong and nothing throws.
 *
 * This fixture deliberately CONTAINS a January entry for the test cell, so a
 * regressed guard finds real data and returns a Map. A fixture with no cells
 * would return null for every input and pass whether or not the bug exists,
 * which is a test that proves nothing.
 */

const ROW = 100
const COL = 200

/**
 * One cell, month=1 (January), holding a single species.
 *
 * Hand-built as an OccBlob rather than bytes parseOccurrence would accept: the
 * header here writes version as a uint32 and carries no taxonomy hash, so it
 * does not match the real v3 layout. That is fine because occCell() is called
 * directly, but do not feed these bytes to parseOccurrence.
 */
function blobWithJanuaryEntry() {
  const hashLen = 0
  const idxStart = 8 + hashLen + 4
  const nCells = 1
  const payloadStart = idxStart + (nCells + 1) * 8
  // varint species delta (1), then the quantised byte q, which occCell turns
  // into -q / scale. It is a log-probability, not a count.
  const payload = [1, 5]
  const total = payloadStart + payload.length

  const buf = new ArrayBuffer(total)
  const u8 = new Uint8Array(buf)
  const view = new DataView(buf)

  u8[0] = 0x57; u8[1] = 0x44; u8[2] = 0x4f; u8[3] = 0x50 // WDOP
  view.setUint32(4, 3, true)                              // version 3
  view.setUint32(8 + hashLen, nCells, true)

  // Index entry: key for (ROW, COL, January), then payload offsets.
  const januaryKey = ((ROW * GRID_COLS + COL) << MONTH_BITS) | 0
  view.setUint32(idxStart, januaryKey, true)
  view.setUint32(idxStart + 4, 0, true)
  view.setUint32(idxStart + 8, 0, true)
  view.setUint32(idxStart + 12, payload.length, true)

  for (let i = 0; i < payload.length; i++) u8[payloadStart + i] = payload[i]

  return {
    version: 3, nCells, idxStart, payloadStart,
    qbits: 8, scale: 1, raw: u8, view, taxHash: null,
  }
}

describe('occCell month guard', () => {
  const o = blobWithJanuaryEntry()

  it('the fixture really does return data for January', () => {
    // Guards the guard: if this is null the other assertions are vacuous.
    const jan = occCell(o as never, ROW, COL, 1)
    expect(jan).not.toBeNull()
    expect(jan!.size).toBeGreaterThan(0)
  })

  it('rejects NaN instead of silently returning January', () => {
    // THE regression. Before the fix this returned January's Map above.
    expect(occCell(o as never, ROW, COL, NaN)).toBeNull()
  })

  it('rejects a month derived from the EXIF null date', () => {
    const month = new Date('0000:00:00 00:00:00').getMonth() + 1
    expect(Number.isNaN(month)).toBe(true)
    expect(occCell(o as never, ROW, COL, month)).toBeNull()
  })

  it('rejects non-integer and infinite months', () => {
    expect(occCell(o as never, ROW, COL, 6.5)).toBeNull()
    expect(occCell(o as never, ROW, COL, Infinity)).toBeNull()
  })

  it('still rejects out-of-range and missing months', () => {
    expect(occCell(o as never, ROW, COL, 0)).toBeNull()
    expect(occCell(o as never, ROW, COL, 13)).toBeNull()
    expect(occCell(o as never, ROW, COL, undefined)).toBeNull()
  })

  it('returns nothing for a month with no data', () => {
    expect(occCell(o as never, ROW, COL, 8)).toBeNull()
  })
})

/**
 * A truncated blob should say it is truncated.
 *
 * parseOccurrence read raw[0..5] and raw[8..15] before checking any length.
 * Out-of-range indexing on a Uint8Array yields undefined rather than throwing,
 * so a short buffer did not fail where the problem was. Instead it either
 * reported "bad magic NaNNaNNaNNaN", or reached raw[i].toString(16) on
 * undefined and threw a TypeError naming neither the file nor the cause.
 * Both send you looking at the wrong thing. The Swift port already guarded.
 */
describe('parseOccurrence truncation guard', () => {
  it('rejects a buffer too short to hold the magic', () => {
    expect(() => parseOccurrence(new Uint8Array(0))).toThrow(/too short/)
    expect(() => parseOccurrence(new Uint8Array([87, 68, 79]))).toThrow(/too short/)
  })

  it('rejects a v2 buffer that stops before the taxonomy hash and cell count', () => {
    // Valid "WDOP", version 2, qbits 8, then nothing. The v2 layout needs the
    // hash through byte 15 and a cell count after it; this stops at 6.
    const short = new Uint8Array([87, 68, 79, 80, 2, 8])
    expect(() => parseOccurrence(short)).toThrow(/too short/)
  })

  it('still reports bad magic when the buffer is long enough to have one', () => {
    const wrong = new Uint8Array(32)
    wrong.set([88, 88, 88, 88])
    expect(() => parseOccurrence(wrong)).toThrow(/bad magic/)
  })
})
