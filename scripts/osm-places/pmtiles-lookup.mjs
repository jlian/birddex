/**
 * PMTiles point-in-polygon reverse geocoding, following the SFO Museum pattern.
 *
 * Their Go implementation (whosonfirst/go-whosonfirst-spatial-pmtiles) does:
 *   coord -> maptile.At(coord, zoom) -> featuresForTile -> PointInPolygon
 *
 * This is the JS equivalent, written so the same code runs in a Cloudflare Worker:
 * the only thing that changes is swapping FileSource for an R2-backed Source.
 *
 * Why this beats the hand-rolled grid-of-blobs: PMTiles stores each large polygon
 * CLIPPED to the tiles it touches, rather than copying the whole ring into every
 * overlapping cell. That was the failure that took our own format from 20 MB to
 * 208 MB when the grid got finer.
 */
import { PMTiles } from 'pmtiles'
import { open as fsOpen } from 'node:fs/promises'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

const ZOOM = 13

// Scores from the tuned Nominatim scorer in functions/lib/geocoding.ts:83.
// Kept verbatim so ranking behaviour matches what production already validated.
function scoreOf(props) {
  const leisure = props.leisure
  const boundary = props.boundary
  if (leisure === 'park') return 100
  if (boundary === 'protected_area' || boundary === 'national_park') return 95
  if (leisure === 'nature_reserve') return 95
  if (leisure === 'garden') return 80
  if (props.natural) return 80
  if (props.landuse === 'forest') return 72
  return 0
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )
  return { x, y, z }
}

/** Ray casting over a ring in tile-local coordinates. */
function pointInRing(px, py, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const yi = ring[i].y
    const xj = ring[j].x
    const yj = ring[j].y
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside
    }
  }
  return inside
}

function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  }
  return Math.abs(a / 2)
}

export async function lookup(pmtiles, lat, lon) {
  const t = lonLatToTile(lon, lat, ZOOM)
  const resp = await pmtiles.getZxy(t.z, t.x, t.y)
  if (!resp) return null

  const tile = new VectorTile(new PbfReader(new Uint8Array(resp.data)))
  const layer = tile.layers.parks
  if (!layer) return null

  // Where the point sits inside this tile, in the layer's integer extent space.
  // MVT quantizes to `extent` units across the tile; at z13 one unit is ~1.2 m,
  // far below anything that matters for naming a birding location.
  const n = 2 ** t.z
  const fx = ((lon + 180) / 360) * n - t.x
  const latRad = (lat * Math.PI) / 180
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - t.y
  const px = fx * layer.extent
  const py = fy * layer.extent

  const hits = []
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i)
    const props = feat.properties || {}
    const name = props.name || props['name:en']
    if (!name) continue
    const score = scoreOf(props)
    if (score === 0) continue

    const geom = feat.loadGeometry()
    for (const ring of geom) {
      if (ring.length < 4) continue
      if (pointInRing(px, py, ring)) {
        hits.push({ name, score, area: ringArea(ring) })
        break
      }
    }
  }
  if (hits.length === 0) return null

  // Highest score wins; ties break to the SMALLEST polygon, i.e. the most
  // specific place that actually contains the point.
  hits.sort((a, b) => b.score - a.score || a.area - b.area)
  return hits[0]
}

const PHOTOS = [
  ['Discovery Park', 47.65976, -122.42877],
  ['Carkeek Park 1', 47.7117, -122.37706],
  ['Carkeek Park 2', 47.71169, -122.37714],
  ['Union Bay Natural Area 1', 47.65426, -122.29524],
  ['Union Bay Natural Area 2', 47.65597, -122.29697],
  ['Union Bay Natural Area 3', 47.65441, -122.29474],
  ['Seattle Arboretum', 47.64244, -122.29497],
  ['Magnolia backyard', 47.63467, -122.39825],
  ['Seattle waterfront', 47.60931, -122.34204],
  ['Smith Island', 48.32521, -122.84339],
  ['Skagit Bay', 48.3262, -122.82199],
  ['Drayton Harbor', 48.98006, -122.78874],
]

async function main() {
  // A byte-range Source. This is the ONLY part that differs in a Worker: swap the
  // file handle for `bucket.get(key, { range: { offset, length } })` on R2.
  const fh = await fsOpen('/home/jlian/pm/wa-parks.pmtiles', 'r')
  const source = {
    getKey: () => 'wa-parks.pmtiles',
    getBytes: async (offset, length) => {
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, offset)
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    },
  }
  const pm = new PMTiles(source)
  const header = await pm.getHeader()
  console.log(
    `pmtiles z${header.minZoom}-${header.maxZoom}  tiles=${header.tileEntries ?? '?'}`,
  )
  console.log()

  let named = 0
  const t0 = Date.now()
  for (const [label, lat, lon] of PHOTOS) {
    const r = await lookup(pm, lat, lon)
    if (r) {
      named++
      console.log(`  ${label.padEnd(28)} ${r.name.slice(0, 34).padEnd(36)} score ${r.score}`)
    } else {
      console.log(`  ${label.padEnd(28)} -- none --`)
    }
  }
  const ms = Date.now() - t0
  console.log()
  console.log(`  named ${named} of ${PHOTOS.length}`)
  console.log(`  ${ms} ms total, ${(ms / PHOTOS.length).toFixed(1)} ms per lookup`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
