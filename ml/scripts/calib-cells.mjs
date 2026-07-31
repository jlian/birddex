#!/usr/bin/env node
// Print the distinct range-prior cell ids needed by the calibration set,
// including the full 3x3 ring (the expanded lookup reads neighbours).
import { readFileSync } from 'fs'
import { latLonToCell } from '../../functions/lib/range-adjust.js'
const pts = JSON.parse(readFileSync(process.argv[2], "utf8"))
const cells = new Set()
let skipped = 0
for (const [lat, lon] of pts) {
  if (lat == null || lon == null) { skipped++; continue }
  const c = latLonToCell(lat, lon)
  if (!c) { skipped++; continue }
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      cells.add((c.row + dr) + "-" + (c.col + dc))
}
console.error("points=" + pts.length + " skipped=" + skipped + " cells=" + cells.size)
console.log([...cells].join("\n"))
