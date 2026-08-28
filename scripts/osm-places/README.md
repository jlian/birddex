# OSM place lookup for #308

Reverse geocoding that runs entirely on Cloudflare: given a photo coordinate,
return the place name a birder would write on a checklist.

**Status: SHIPPED.** `/api/geocoding/reverse` serves from this archive, and the
paid provider was removed from the reverse path entirely. Forward place search
still uses Geoapify, which is a different problem this archive cannot answer.

The sections below are ordered oldest to newest. Everything under "Spike
history" records how the approach was chosen and describes builds that are NOT
what ships; the shipped design is summarised here.

## What ships

- One PMTiles archive in R2, built by `build-global.sh`, uploaded by
  `r2-upload.mjs` under the dated key `places-20260827.pmtiles`.
- Zoom 12, not the z13 used in the early spike. Measured over 20,000
  coordinates, z12 named MORE places at every buffer.
- TWO layers: `parks` (what a place is called) and `admin` (ISO 3166 codes for
  the eBird export).
- No provider fallback. A coordinate with no nearby named place returns null,
  and the app offers an editable coordinate string.

## Local development

The archive bucket stays private. The `PLACES` binding uses Wrangler's mixed
local/remote mode: application code and D1 run locally, while R2 range reads go
to the real archive. Sign in with `npx wrangler login`, then use the normal
`npm run dev` or `npm start` command. Deployed Workers receive bindings without
application secrets, and local remote mode uses the developer's Wrangler login.
S3 credentials are not needed for reads. Keep the administration credentials in
the ignored `.r2.vars` file, not `.dev.vars`, because Wrangler exposes every
`.dev.vars` entry to locally executed Worker code. Copy `.r2.vars.example`, fill
it, then source it only when running `r2-upload.mjs`.

Cloudflare does not offer a runtime read-only mode for Worker R2 bindings. The
application declares `PLACES` as get-only in TypeScript and treats dated archive
keys as immutable, which prevents accidental writes but is not a security
boundary for arbitrary Worker code.

Use `npx wrangler dev --local` when deliberately testing without remote
resources. That switches `PLACES` back to Miniflare's local R2 simulation; load
an archive there with `r2-load.mjs` when an offline end-to-end lookup is needed.
Playwright runs use mixed mode so their Worker keeps D1 local while reading the
real R2 archive. The iOS suite covers the same archive through the deployed PR
preview. Run Playwright with `WRANGLER_LOCAL_ONLY=true` only when an archive has
been loaded into local R2 for an intentionally offline integration run.
The bucket does not need an `r2.dev` URL or a custom domain: those expose raw
objects over HTTP and do not exercise the private `R2Bucket.get()` path used in
production.

## Spike history

## Why not the Wikidata centroid extract

The first attempt built a 1.2M-place extract from Wikidata and ranked candidates
by distance decay against a per-class radius. It never got Discovery Park right,
because a centroid plus a guessed radius cannot answer "am I inside this park".
Full write-up is in the issue; the short version is that the ceiling was the data
model, not the tuning.

## Why not self-hosted Nominatim

We ran Nominatim before (see `cdb2c72^`). The ranking was fine. What made it
untenable was the usage policy: 1 request/second, no bulk use, mandatory caching,
and app-wide global throttling. That is an operational lift, not an accuracy
problem. Self-hosting solves the policy but needs an always-on server, which is
what this issue exists to avoid.

## The approach: PMTiles point-in-polygon

Prior art, not invention. SFO Museum runs a global point-in-polygon reverse
geocoder over an 8 GB PMTiles archive on object storage for a few dollars a
month:

- https://millsfield.sfomuseum.org/blog/2022/12/19/pmtiles-pip/
- https://github.com/whosonfirst/go-whosonfirst-spatial-pmtiles (BSD-3-Clause)

Their algorithm, from `database_index.go`:

```
coord -> maptile.At(coord, zoom) -> featuresForTile(tile) -> PointInPolygon
```

`pmtiles-lookup.mjs` is the JS equivalent, written so the same code runs in a
Worker. The only platform-specific piece is the byte-range `Source`; swap the
file handle for `bucket.get(key, { range: { offset, length } })` on R2.

## Build

Tippecanoe **cannot build on the CIFS-mounted NAS**: it needs SQLite locking,
which fails with `database is locked`. Build on local disk.

```sh
curl -sL -o washington.osm.pbf \
  https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf

osmium tags-filter -o wa-parks.osm.pbf washington.osm.pbf \
  wr/leisure=park,nature_reserve,garden \
  wr/boundary=protected_area,national_park \
  wr/landuse=forest \
  wr/natural=wood,water,beach,bay

osmium export wa-parks.osm.pbf -o wa-parks.geojson -f geojson

tippecanoe -o wa-parks.pmtiles -z13 -Z13 -pf -pk \
  --no-simplification-of-shared-nodes \
  --no-tiny-polygon-reduction \
  -l parks wa-parks.geojson
```

`-pf -pk` disable tippecanoe's feature-dropping limits, which otherwise silently
discard polygons to hit a tile size target. `-z13 -Z13` builds only the zoom we
query.

## Results

361 MB PBF in, 20.3 MB PMTiles out, 226,226 features.

```
Discovery Park            -> Discovery Park              score 100
Carkeek Park x2           -> Carkeek Park                score 100
Union Bay Natural Area    -> Union Bay Natural Area      score  95
Seattle Arboretum         -> Washington Park Arboretum   score 100
Magnolia backyard         -> Magnolia Park               score 100
Drayton Harbor            -> Drayton Harbor              score  80

  named 9 of 12 real photo coordinates
  2.0 ms per lookup
```

Scores are lifted verbatim from the tuned scorer in `functions/lib/geocoding.ts`
(park 100, protected_area 95, natural 80, forest 72), so the ranking work that
was already validated in production carries over unchanged.

MVT quantization is not a problem for this use: at z13 one integer unit is about
1.2 m. MVT clips geometry per tile, and a clipped ring is self-consistent within
its own tile, so containment still answers correctly.

## Rejected alternatives, with measurements

**Hand-rolled grid of gzipped blobs** (`grid_cells_experiment.py`). Store polygon
geometry per grid cell, one R2 object per cell. Worked at a 27 km grid (20 MB),
but a large protected area gets copied whole into every overlapping cell, so a
9 km grid exploded to 208 MB and climbing. PMTiles avoids this by storing each
polygon **clipped** per tile instead of duplicated.

**H3 covering** (`h3_cover_experiment.py`). Precompute which H3 cells each park
covers, store `cell -> name`, so runtime is one hash lookup with no geometry.
Genuinely cheap and it does not duplicate, because a cell has exactly one parent.
Measured at res 10 for Washington: 4,791,572 cells, 15.0 MB, median 8.1 KB per
shard. But accuracy is bounded by hexagon size and it got the Arboretum wrong
(`Lake Washington`), where exact point-in-polygon gets it right. Kept here as a
fallback if Worker CPU ever becomes the binding constraint.

**Overture Maps.** No licensing advantage: the `base` and `divisions` themes are
OSM pass-through published under ODbL, and `divisions` is administrative units
with no parks in it. Use osmium on Geofabrik extracts instead.

## Licensing: ODbL

Wikidata is CC0. OSM is ODbL 1.0, a share-alike **database** license, so this is
a real change.

- **Section 4.5(b)**: creating a Produced Work does not create a Derivative
  Database. The place name shown to a user is a Produced Work, so the app itself
  is unaffected.
- **Section 4.6**: publicly using a Derivative Database requires offering either
  (a) the entire derived database, or (b) **the method of making the alterations,
  such as an algorithm**.

Option (b) is satisfied by publishing this directory: the build commands above
plus the exact Geofabrik source URL make the archive fully reproducible, so no
derived data needs hosting.

Done before shipping:

- [x] ODbL notice for the derived tiles, in the `wrangler.toml` binding comment
- [x] Attribution returned by the route as `(c) OpenStreetMap contributors,
      ODbL 1.0` and shown under the location control
- [x] Row updated in `docs/CONTENT_RIGHTS_AND_ATTRIBUTION.md`

Not legal advice. This is a reading of the license text.

## Known gaps

These are the gaps in the SHIPPED archive. Gaps listed in the spike history
above were fixed on the way here and are recorded there for the reasoning, not
as current status.

- A lookup reads only the tile containing the point, so a feature lying wholly
  beyond a tile edge is invisible. Measured over 400 coordinates, a neighbouring
  tile held a nearer named feature 4.8% of the time, but a genuinely DIFFERENT
  name won only 1.3%, and those are near-ties. Reading the 3x3 neighbourhood
  would cost 9 times the R2 reads on every request, which is the wrong trade for
  a name the user can edit in one tap.
- Rural coverage depends on OSM. Dehua, Fujian returns no named place because
  the rice paddies there carry no named feature within 2 km. The ISO codes still
  resolve, so the eBird export is unaffected.
- Ranking is tuned on 25 hand-graded bird photos. That is a small sample for a
  global archive, and the band constant would want re-measuring against a larger
  set before being treated as optimal.
