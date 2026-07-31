#!/usr/bin/env node
// Ground truth for the projection check: print JS cell ids for known points.
import { lonLatToEqualEarth, xyToCell } from '../../functions/lib/range-adjust.js'
const PTS = [
  [47.6543,-122.2952], [47.6062,-122.3421], [41.9632,-87.6342],
  [20.7148,-156.2502], [52.3581,4.8826], [45.8097,9.0846],
  [25.7,118.24], [24.998,121.581], [-33.8688,151.2093],
  [-1.2921,36.8219], [64.1466,-21.9426], [0.0,0.0],
]
for (const [lat, lon] of PTS) {
  const { x, y } = lonLatToEqualEarth(lon, lat)
  const c = xyToCell(x, y)
  console.log(JSON.stringify({ lat, lon, row: c ? c.row : null, col: c ? c.col : null }))
}
