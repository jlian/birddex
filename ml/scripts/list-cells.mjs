#!/usr/bin/env node
// Print the exact cell ids the benchmark needs (same math as
// download-range-cells.mjs) so they can be fetched via wrangler instead of
// the S3 API, which needs R2 keys we do not have.
import { latLonToCell, nearestNeighborCell, lonLatToEqualEarth } from '../../functions/lib/range-adjust.js'
const LOCS = [
  [47.6543,-122.2952],[47.6399,-122.4039],[47.7117,-122.3771],[48.3918,-122.4885],
  [36.6002,-121.8947],[47.6399,-122.2958],[48.9784,-122.7913],[47.6062,-122.3421],
  [47.6600,-122.4287],[41.9632,-87.6342],[42.0089,-87.8310],[20.7148,-156.2502],
  [52.3581,4.8826],[45.8097,9.0846],[25.7,118.24],[24.998,121.581],[40.0,-100.0],
  [48.3204,-122.8352],
]
const cells = new Set()
for (const [lat,lon] of LOCS) {
  const c = latLonToCell(lat,lon); if (!c) continue
  for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) cells.add(`${c.row+dr}-${c.col+dc}`)
  const {x,y} = lonLatToEqualEarth(lon,lat)
  const n = nearestNeighborCell(x,y,c.row,c.col)
  if (n) cells.add(`${n.row}-${n.col}`)
}
console.log([...cells].join("\n"))
