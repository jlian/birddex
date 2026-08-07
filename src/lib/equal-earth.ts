// Equal Earth (EPSG:8857) projection and grid geometry.
//
// The occurrence prior is keyed by Equal Earth cell, so this is the projection
// that decides which cell a photo falls in. Pure math: no I/O, no bindings.
//
// Formerly functions/lib/range-adjust.js, which was two modules wearing one
// name. The BirdLife range-trust half was deleted with the GPT path, having
// been measured inert: the fitted smoothing weight landed near 1e-10, putting
// the status term ten orders of magnitude below the occurrence counts. It was
// JavaScript under functions/ because Node build scripts imported it directly
// and there is no allowJs; those scripts are gone, and the only consumers now
// are src/lib/rank.ts and src/lib/occurrence.ts, so it belongs here as TS.

// ── Grid constants (EPSG:8857 Equal Earth) ──────────────────
export const GRID_ORIGIN_X = -17226000
export const GRID_ORIGIN_Y = 8343000
export const GRID_CELL_SIZE = 27000
export const GRID_COLS = 1276
export const GRID_ROWS = 618

// ── Equal Earth projection ──────────────────────────────────

export function lonLatToEqualEarth(lon: number, lat: number): { x: number; y: number } {
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

/** Returns null when the point falls outside the grid, which is a real case:
 *  the Equal Earth bounding box includes ocean that no cell covers. */
export function xyToCell(x: number, y: number): { row: number; col: number } | null {
  const col = Math.floor((x - GRID_ORIGIN_X) / GRID_CELL_SIZE)
  const row = Math.floor((GRID_ORIGIN_Y - y) / GRID_CELL_SIZE)
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null
  return { row, col }
}
