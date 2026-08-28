# Forward place search: phase 1 feasibility

Issue #343, phase 1. This records the measurement that decides the approach, so
phase 2 starts from evidence rather than from the estimate in the issue.

**Verdict: D1 FTS5 is viable with a very large margin. Build it.**

## The gate

Step 7 says adopt D1 only if the finished global database is at most 7 GB,
leaving rebuild headroom under D1's 10 GB hard limit.

| Measurement | Value |
| --- | --- |
| Canonical rows, global | 3,564,834 |
| Exported TSV | 0.292 GB |
| Content table | 0.388 GB |
| FTS5 index | 0.067 GB |
| **Total database** | **0.455 GB** |
| Share of the 7 GB gate | **6.5%** |

The result is not close to the limit, so the R2 prefix/FST shard fallback is not
needed and phase 2 can proceed as written. Load time is 11 s for the content and
6 s to build the index, both on cached input.

Two schema choices produce most of that margin, and both were chosen for it:

`places_fts` is an **external content** table (`content=places`). FTS5 indexes
the text without storing a second copy. Text is the bulk of this dataset, so an
ordinary FTS5 table would have roughly doubled it.

`detail=none` drops per-position offsets, which exist for phrase and NEAR
queries. Search here is prefix matching on short place names and never uses
them.

The alias set is deliberately bounded to `name`, `name:en`, `int_name`,
`alt_name`, `official_name` and `short_name` rather than every `name:*` language
variant. A planet corpus carries dozens of variants for a famous feature, none
of which this app's users type.

## Latency

Measured on the full global database, 20 runs each, SQLite on local NVMe. D1
will be slower and this is not a substitute for measuring it there, but it does
show the shape of the problem.

| Query | p50 | p95 | Top hit |
| --- | --- | --- | --- |
| central park | 11.34 ms | 13.29 ms | Central Park |
| discovery park | 6.46 ms | 7.20 ms | Discovery Park |
| st martin | 0.63 ms | 1.08 ms | St. Martin |
| union bay | 0.64 ms | 0.87 ms | Union Bay |
| tokyo | 0.44 ms | 0.78 ms | Tokyo |
| carkeek | 0.06 ms | 0.09 ms | Carkeek |

`donana` returning Doñana confirms diacritic folding works from an ASCII query.

### The trailing star was the whole problem

The first measurement had `central park` at 96 ms and `discovery park` at 82 ms,
which looked like a candidate-set-size problem. It was not: `discovery park`
returns only 164 candidates and still cost 82 ms, so the time was going
somewhere else.

Isolating single tokens found it. A trailing `*` on a common COMPLETE word is
the entire cost:

| Token | Rows | Time |
| --- | --- | --- |
| `"park"*` | 231,558 | 42.09 ms |
| `park` | 219,289 | 6.91 ms |
| `"central"*` | 7,572 | 2.18 ms |
| `central` | 7,331 | 0.26 ms |

The star buys 12,269 extra rows for `park`, all of them `parkway` and
`parkland`, which nobody searching for a park wants, and charges 6x for them.

Dropping prefix matching entirely gives a **13x improvement with identical top
hits across the whole golden set**. That is sound here specifically because
#343 states autocomplete is not required: this is submitted search, where the
user has finished typing. Reintroducing prefix matching for autocomplete would
need this measured again.

Quoting each token has a second benefit: FTS5 operators a user types (`AND`,
`NOT`, `*`, `^`) become literal text rather than query syntax.

## Ranking

Text quality first, then the WingDex category score, then importance, then the
stable id so the order is total and reproducible.

One addition was necessary. `bm25` alone cannot distinguish an exact full-name
match from a prefix hit on a longer name, so "central park" ranked `Centrální
park` above the real Central Park. Leading the sort with an exact normalised
match fixes it, and an index on `places(alias)` keeps that term cheap.

## Three bugs the measurement caught

**Osmium writes identity into `properties` as `@type`/`@id`**, not as a
top-level `id`. Reading the wrong place produced zero rows for two whole
regions, silently, because every record then failed the identity guard.

**OSM has its own free-text `importance` tag.** Values include `national`,
`regional`, `international` and one reading `Bulgarian 100`. It collides with
the numeric score the reverse archive bakes in. The export now keeps only a
clean integer in 0-255, so an OSM tag can never be mistaken for a ranking value.

## Importance

The first build carried importance on exactly ONE record, because the reverse
pipeline joins it between `osmium export` and tippecanoe rather than into this
export path. A tie-breaker that is silently always null looks like working code,
so it is joined here instead.

Search keeps the QID as a column, so the join runs once at load time against the
whole corpus rather than once per region, reading the SAME `qid-importance.tsv`
the archive uses. A place therefore cannot rank differently in forward and
reverse search.

| Measure | Count | Share |
| --- | --- | --- |
| Records carrying a QID | 615,991 | 17.3% |
| Records carrying importance | 378,320 | 10.6% |
| QIDs matched in the table | | 61.4% |

The database size is unchanged at 0.455 GB, because the score is a small integer
replacing nothing.

**Closed ways were exported twice**, once as an area and once as a linestring,
which is osmium's documented behaviour when `area_tags` and `linear_tags` are
both on. Europe alone had 1,101,405 duplicate ids, each twin carrying a slightly
different representative point. The reverse pipeline had already hit and fixed
this exact bug; reusing its linear-tag list fixed it here. Global rows fell from
6,223,129 to 3,564,834, so **42% of the original corpus was duplicates**.

A fourth, smaller issue is handled in the loader rather than the export:
regional extracts OVERLAP at borders, so a feature straddling Europe and Asia
appears in both files with the same stable id. No single region can see that
collision, so deduplication belongs at load time.

## Representative points

A search result needs one coordinate, and it must lie ON the feature. A centroid
does not: for a C-shaped bay or a reserve with a lake cut out of it, the
centroid falls outside the polygon, so "take me here" points at the notch.

Polygons use a scanline point-on-surface: the horizontal line at the vertical
midpoint, then the middle of the widest interior span. Verified against a
C-shaped test polygon where the centroid is provably outside and the
point-on-surface is inside. Lines use the midpoint **vertex**, so the point is
always a position a mapper actually placed, even on a coastline that doubles
back.

## Category distribution

water 1,087,247 · place 624,213 · park 621,476 · lodging 358,717 ·
landcover 254,627 · natural-other 252,077 · reserve 162,016 · poi 112,373 ·
attraction 62,115 · golf-course 29,973

Inclusion mirrors `scoreOf()` and `kindOf()` in `functions/lib/place-rank.ts`
rather than defining a second contract, so forward and reverse search agree on
what a birding place is. Anything scoring 0 is dropped.

## Negative control

Addresses must not be searchable. `98115` returns 0 hits and `10 downing`
returns 1, which is a named feature rather than a house number. `main street`
returns 197, all of them named places that happen to contain those words, such
as parks and hotels, because the upstream `FILTER` never selects `highway=*`.
Phase 2 should keep a golden test asserting no street or postcode results.

## Reproducing

```bash
osmium export <filtered-region>.osm.pbf -f geojsonseq \
  -c scripts/osm-places/search-export.json -o - \
  | python3 scripts/osm-places/build-search-records.py > region.tsv
cat *.tsv > all.tsv
python3 scripts/osm-places/build-search-db.py all.tsv places-search.sqlite \
  qid-importance.tsv
```

The export reads the **cached filtered PBFs** that the reverse build already
produced, so it costs no re-filtering of the 84 GB source. Full global export is
about 20 minutes, dominated by Europe.

## What phase 2 inherits

- Size is a non-issue: 6.5% of the gate, so there is room for the context and
  region-code columns step 4 still needs.
- Latency is resolved for submitted search. If autocomplete is ever added, the
  prefix-matching cost measured above comes back and needs a different answer.
- Importance is joined and covers 10.6% of records.
- Nothing runtime changed. Geoapify still serves search, per the issue.
