/**
 * Shared range-prior logic used by both the Cloudflare Workers runtime
 * (range-filter.ts) and the offline benchmark/fixture scripts.
 *
 * Pure functions only - no I/O, no R2, no Node/Cloudflare APIs.
 */

// ── Grid constants (EPSG:8857 Equal Earth) ──────────────────
export const GRID_ORIGIN_X = -17226000
export const GRID_ORIGIN_Y = 8343000
export const GRID_CELL_SIZE = 27000
export const GRID_COLS = 1276
export const GRID_ROWS = 618
export const RECORD_SIZE = 11

// ── Equal Earth projection ──────────────────────────────────

export function lonLatToEqualEarth(lon, lat) {
  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796
  const a = 6378137.0, f = 1 / 298.257223563
  const b = a * (1 - f), e2 = 1 - (b * b) / (a * a), e = Math.sqrt(e2)
  const R = a * Math.sqrt(0.5 * (1 + ((1 - e2) / (2 * e)) * Math.log((1 + e) / (1 - e))))
  const qp = 1 + ((1 - e2) / (2 * e)) * Math.log((1 + e) / (1 - e))
  const lam = (lon * Math.PI) / 180, phi = (lat * Math.PI) / 180
  const sinPhi = Math.sin(phi), eSin = e * sinPhi
  const q = (1 - e2) * (sinPhi / (1 - e2 * sinPhi * sinPhi) - (1 / (2 * e)) * Math.log((1 - eSin) / (1 + eSin)))
  const beta = Math.asin(q / qp)
  const theta = Math.asin((Math.sqrt(3) / 2) * Math.sin(beta))
  const t = theta, t2 = t * t, t6 = t2 * t2 * t2
  const denom = 3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))
  return {
    x: R * ((2 * Math.sqrt(3) * lam * Math.cos(t)) / denom),
    y: R * t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
  }
}

export function xyToCell(x, y) {
  const col = Math.floor((x - GRID_ORIGIN_X) / GRID_CELL_SIZE)
  const row = Math.floor((GRID_ORIGIN_Y - y) / GRID_CELL_SIZE)
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null
  return { row, col }
}

export function latLonToCell(lat, lon) {
  const { x, y } = lonLatToEqualEarth(lon, lat)
  return xyToCell(x, y)
}

/**
 * Nearest neighbor cell based on where the point falls within its cell.
 * Returns null if the neighbor is outside grid bounds.
 */
export function nearestNeighborCell(x, y, row, col) {
  const fx = (x - (GRID_ORIGIN_X + col * GRID_CELL_SIZE)) / GRID_CELL_SIZE
  const fy = ((GRID_ORIGIN_Y - row * GRID_CELL_SIZE) - y) / GRID_CELL_SIZE
  const dLeft = fx, dRight = 1 - fx, dTop = fy, dBottom = 1 - fy
  const minDist = Math.min(dLeft, dRight, dTop, dBottom)

  let nr = row, nc = col
  if (minDist === dLeft) nc = col - 1
  else if (minDist === dRight) nc = col + 1
  else if (minDist === dTop) nr = row - 1
  else nr = row + 1

  if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) return null
  return { row: nr, col: nc }
}

/**
 * All in-bounds neighbor cells in the 3x3 ring around (row, col), ordered by
 * proximity to the point's position within its cell (closest edge/corner
 * first). Used to blend range data across cell boundaries: coastal and
 * range-edge points frequently fall in a cell that lacks a species whose
 * range polygon covers an adjacent (often diagonal) cell.
 *
 * `nearestNeighborCell` only returns the single closest edge cell, which
 * misses diagonals and the other three edges; a point right on a coastline
 * can read out-of-range for a species that is plainly present one cell over.
 * This returns up to 8 cells so callers can scan the full ring.
 */
export function neighborCells(x, y, row, col) {
  const fx = (x - (GRID_ORIGIN_X + col * GRID_CELL_SIZE)) / GRID_CELL_SIZE
  const fy = ((GRID_ORIGIN_Y - row * GRID_CELL_SIZE) - y) / GRID_CELL_SIZE
  const out = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const nr = row + dr, nc = col + dc
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue
      // squared distance from the point to the target cell (0 if inside the
      // shared edge/corner direction); used only for ordering.
      const ddx = dc === -1 ? fx : dc === 1 ? 1 - fx : 0
      const ddy = dr === -1 ? fy : dr === 1 ? 1 - fy : 0
      out.push({ row: nr, col: nc, dist: ddx * ddx + ddy * ddy })
    }
  }
  out.sort((a, b) => a.dist - b.dist)
  return out.map(({ row, col }) => ({ row, col }))
}

// ── Blob parsing ────────────────────────────────────────────

/**
 * Parse a decompressed cell blob buffer (Uint8Array or Buffer) and extract
 * BirdLife attributes for requested species codes.
 */
export function parseCellBlob(data, wanted) {
  const result = new Map()
  let remaining = wanted.size
  for (let offset = 0; offset + RECORD_SIZE <= data.length; offset += RECORD_SIZE) {
    let code = ''
    for (let i = 0; i < 8; i++) {
      const ch = data[offset + i]
      if (ch === 0x20) break
      code += String.fromCharCode(ch)
    }
    if (wanted.has(code)) {
      result.set(code, {
        presence: data[offset + 8],
        origin: data[offset + 9],
        seasonal: data[offset + 10],
      })
      if (--remaining === 0) break
    }
  }
  return result
}

// ── Tiered confidence adjustment ────────────────────────────
//
// Four layers of multipliers, applied multiplicatively:
//   1. Base: status (present=1.0, near-range=0.85, out-of-range=0.65)
//   2. Presence quality (Extant=1.0, Possibly Extant=0.95, etc.)
//   3. Origin type (Native=1.0, Vagrant=0.85, etc.)
//   4. Seasonal match (in-season=1.0, out-of-season=0.9)
//
// Layers 2-4 only apply when status is 'present' or 'near-range'.

export const NEAR_RANGE_TRUST = 0.85
export const OUT_OF_RANGE_TRUST = 0.65

export function presenceTrust(presence) {
  switch (presence) {
    case 1: return 1.0   // Extant
    case 3: return 0.95  // Possibly Extant
    case 6: return 0.9   // Presence Uncertain
    case 4: return 0.8   // Possibly Extinct
    default: return 0.9
  }
}

/**
 * Origin trust from bitmask. Uses the best (highest-trust) origin present.
 * Native/Reintroduced/Introduced/Assisted = 1.0 (species is really here).
 */
export function originTrust(originMask) {
  // bits 0,1,2,5 = Native, Reintroduced, Introduced, Assisted Colonisation
  if (originMask & 0b100111) return 1.0
  // bit 4 = Origin Uncertain
  if (originMask & 0b010000) return 0.95
  // bit 3 = Vagrant only
  if (originMask & 0b001000) return 0.85
  return 1.0
}

// Seasonal bitmask constants
const S_RESIDENT    = 1 << 0
const S_BREEDING    = 1 << 1
const S_NONBREEDING = 1 << 2
const S_PASSAGE     = 1 << 3
const S_UNCERTAIN   = 1 << 4

// Northern hemisphere month sets (0-indexed)
const NH_BREEDING    = new Set([3, 4, 5, 6, 7])
const NH_NONBREEDING = new Set([9, 10, 11, 0, 1])
const NH_PASSAGE     = new Set([2, 3, 8, 9])

/**
 * Seasonal trust: hemisphere-aware breeding/non-breeding match.
 */
export function seasonalTrust(seasonalMask, month, lat) {
  if (month === undefined || month === null || month < 0 || month > 11) return 1.0
  if (seasonalMask & (S_RESIDENT | S_UNCERTAIN)) return 1.0
  if ((seasonalMask & S_BREEDING) && (seasonalMask & S_NONBREEDING)) return 1.0

  const southern = (lat ?? 0) < 0
  const breeding = southern ? NH_NONBREEDING : NH_BREEDING
  const nonbreeding = southern ? NH_BREEDING : NH_NONBREEDING

  if ((seasonalMask & S_BREEDING) && breeding.has(month)) return 1.0
  if ((seasonalMask & S_NONBREEDING) && nonbreeding.has(month)) return 1.0
  if ((seasonalMask & S_PASSAGE) && NH_PASSAGE.has(month)) return 1.0

  return 0.9
}

/**
 * Adjust confidence using layered BirdLife range data.
 *
 * @param {number} confidence - LLM confidence (0-1)
 * @param {{status: string, presence?: number, origin?: number, seasonal?: number}} range
 * @param {number} [month] - 0-indexed month
 * @param {number} [lat] - latitude for hemisphere detection
 */
export function adjustConfidence(confidence, range, month, lat) {
  if (range.status === 'no-data') return confidence
  if (range.status === 'out-of-range') return confidence * OUT_OF_RANGE_TRUST

  // present or near-range: apply layered multipliers
  let trust = range.status === 'near-range' ? NEAR_RANGE_TRUST : 1.0

  if (range.presence !== undefined) trust *= presenceTrust(range.presence)
  if (range.origin !== undefined) trust *= originTrust(range.origin)
  if (range.seasonal !== undefined) trust *= seasonalTrust(range.seasonal, month, lat)

  return confidence * trust
}
