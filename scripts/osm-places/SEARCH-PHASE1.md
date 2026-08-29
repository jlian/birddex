# Forward place search: phase 1 feasibility

Issue #343, phase 1. This records the measurement that decides the approach, so
later phases start from evidence rather than the estimate in the issue.

**Verdict: FTS5 over this corpus is viable. The remaining question is where the
database is hosted, not whether the approach works.**

All figures below come from one build of the complete global corpus, measured
with every index created.

## The gate, and the constraint that actually binds

Step 7 says adopt D1 only if the finished global database is at most 7 GB,
leaving rebuild headroom under D1's 10 GB hard limit. The database is 0.737 GB,
about a tenth of that gate, so the R2 prefix/FST shard fallback is not needed on
size grounds.

The gate in the issue is not the limit that binds, though. This account is on
**Workers Free**, where the limits are:

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| One database | 500 MB | 10 GB |
| All databases | 5 GB | 1 TB |

At 0.737 GB the corpus does NOT fit in a single free-tier database. The 5 GB
account total is comfortable, and two environments cost 1.5 GB of it, so the
per-database cap is the only real obstacle.

This is measured rather than assumed: an earlier note in this file claimed the
account was on Workers Paid, inferred from a successful API call. That inference
was wrong. The subscription page shows Workers Free, with R2 on a paid plan
separately.

### Where the bytes are

Measured with `dbstat` on the finished database:

| Object | Size | Share |
| --- | --- | --- |
| `places` | 352.4 MB | 46.7% |
| `idx_place_alias` | 117.9 MB | 15.6% |
| `place_alias` | 116.1 MB | 15.4% |
| `sqlite_autoindex_places_1` | 82.4 MB | 10.9% |
| `places_fts_data` | 50.0 MB | 6.6% |
| `places_fts_docsize` | 36.1 MB | 4.8% |
| `places_fts_idx` | 0.2 MB | 0.0% |

The FTS5 index is only 12% of the file. The content table and the alias
machinery are 89% of it, so shrinking the index is not where a saving lives.

That matters for the hosting decision, because the options differ in cost:

- Upgrade to Workers Paid. One database, no schema surgery, 10 GB ceiling.
- Split the corpus across free-tier databases and query the relevant one.
  Cheap in money, but a cross-database FTS query is not something D1 does, so
  the Worker would have to route by region and the ranking would no longer see
  a single global candidate pool.
- Trim the corpus to fit 500 MB. `place_alias` and its index are 234 MB
  together, and `alias` is duplicated between `places` and `place_alias`.
  Dropping the concatenated column and narrowing the alias set would plausibly
  reach the cap, at the cost of recall on alternate names.
- Fall back to the immutable R2 shards the issue names as the alternative.

This is John's call and it is deliberately deferred. It does not block the
runtime work: local D1 has no size cap, so phases 2 and 3 proceed against the
full global corpus regardless.

## Local development against the real corpus

The runtime is validated locally before anything is uploaded, which keeps the
iteration loop off the remote database entirely.

Local D1 is `workerd` with real SQLite behind it, so it runs genuine FTS5,
including `unicode61 remove_diacritics 2`, `detail=full`, external-content
tables and `bm25`. Verified: remote D1 accepts the same DDL, so the local result
is not a simulation that diverges at deploy time.

The local persistence directory holds one plain SQLite file per database, plus a
`_cf_METADATA` table. A database built offline can therefore be dropped straight
in and served through a real binding, with no import step and no rows-written
cost. Verified end to end: a prebuilt FTS5 database copied into
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` answered a ranked
prefix query through `env.DB`.

The file name there is a generated Durable Object id, so match the single
`.sqlite` file in that directory rather than hardcoding the name, and pass
`--persist-to` to keep a 0.737 GB file out of the repository.

`places_fts` is an **external content** table (`content=places`), so FTS5
indexes the text without storing a second copy; an ordinary FTS5 table would
have roughly doubled the text bytes.

`detail=full` is kept even though phrase and NEAR queries are never used.
`detail=none` looks like free savings and was used at first, but it makes
`ORDER BY rank` about twice as slow, because bm25 must score without
per-position data. On the full corpus it cost 2.3% of the database and roughly
halved query time, which is the right trade when the corpus sits at a tenth of
the gate.

The alias set is bounded to `name`, `name:en`, `int_name`, `alt_name`,
`official_name` and `short_name` rather than every `name:*` variant. A planet
corpus carries dozens of language variants for a famous feature, none of which
this app's users type.

## Latency

Full global database, 20 runs each, SQLite on local NVMe. D1 will be slower;
this shows the shape of the problem, not the production number.

| Query | p50 | p95 | Top hit |
| --- | --- | --- | --- |
| discover par | 80.50 ms | 84.65 ms | Discovery Park |
| central park | 60.07 ms | 60.94 ms | Central Park |
| discovery park | 51.72 ms | 56.41 ms | Discovery Park |
| st martin | 49.60 ms | 88.46 ms | St Martin |
| union bay | 5.13 ms | 5.90 ms | Union Bay |
| tokyo | 1.07 ms | 1.48 ms | Tokyo |
| skagit | 0.56 ms | 0.72 ms | Skagit |
| carkeek | 0.41 ms | 0.53 ms | Carkeek |

`donana` returning Doñana confirms diacritic folding works from an ASCII query.

**Prefix matching is what costs this.** A single rare token answers in under a
millisecond. The slow cases are all common tokens with a trailing `*`:
`"park"*` matches 231,558 rows and costs 42 ms on its own, against 6.9 ms for
exact `park`, and the extra rows are `parkway` and `parkland`.

Prefix matching was dropped twice during development on that basis, and both
times it was wrong: #343 requires token-prefix matching, and `discover par` has
to find Discovery Park. Starring only the LAST token was the second attempt and
also failed, because `discover` is not a token in `discovery park`. Every token
carries a star now, and the bounded candidate stage is what pays for it.

A bare `LIMIT` does not bound the work: it applies after the full MATCH is
evaluated and sorted, so a common prefix would run the whole ordering over
hundreds of thousands of rows. The query therefore takes the top 200 rows by FTS
rank in an inner stage, which FTS5 satisfies from its own index, and applies the
secondary ranking to that bounded pool. Exact alias matches enter through a
separate arm so a low bm25 rank cannot cut the row the ranking exists to
promote.

Profiling found the cost was NOT the candidate limit: dropping it from 200 to 50
changed nothing. `ORDER BY rank` was the expense, and it was the `detail=none`
setting making bm25 work harder. Switching to `detail=full` halved the slow
cases. What remains is the honest cost of scoring a large prefix match, and it
is now the number phase 2 should watch on D1.

## Ranking

Per #343 step 12: text quality first, then the WingDex category score, then
importance, then the stable id so the order is total and reproducible. One
amendment to that order is documented below.

`bm25` cannot distinguish an exact full-name match from a prefix hit inside a
longer name, so "central park" ranked `Centrální park` above the real one. An
exact normalised match leads the sort. It is tested against `place_alias`, one
row per alias, not against the concatenated `places.alias` column, or the boost
would only ever fire for places with exactly one name.

Inside the exact group the FTS rank is neutralised. It cannot separate names
that are identical, and letting it try ranked whichever matching name happened
to be shortest.

### Amendment to step 12: importance leads inside the exact group

Step 12 orders category score before importance. For EXACT matches that returns
the wrong answer, so the criterion was amended with John's agreement on
2026-08-28.

`central park` matches **521 places exactly**. Two of them score 26, which is
the `tourism=zoo`/`aquarium`/`theme_park` tier, against 25 for the 501 plain
parks in that set, so category-first ranking put a park in Tajikistan and one in
Uzbekistan above the one in New York, which carries importance 156 against their
nothing. Neither has any importance score at all.

(An earlier draft blamed `tourism=attraction`. That tier scores 24, BELOW a
park, so it could not have produced this. The winning rows carry the top tourism
tier; the generated contract labels that tier `attraction` as its `kind`, which
is what the mislabelling came from.)

The category score answers "what KIND of place is this", which is the right
tie-breaker while candidates still differ by name. Once several places share a
name exactly, that question is spent and the remaining one is "which of these
does the searcher mean", which is what importance measures. Category still
breaks ties beneath it, and non-exact candidates keep the documented order.

## Region codes and locality names

Attached offline, so a five-result search costs no archive reads at query time:
the reverse route resolves codes by reading the PMTiles `admin` layer for one
coordinate, and doing that per result would mean up to five extra R2 range
reads per search.

The same join also carries the boundary's NAME, not only its ISO code. Step 4
asks for useful locality names, and a code cannot satisfy it: the two parks
called `Memorial Park` in `US-WA` render as two identical rows, so the searcher
cannot tell which is which. The visible `context` is now the locality plus the
country, and the ISO codes still travel separately in `stateProvince` and
`countryCode` for the eBird mapping.

`name:en` is preferred over `name`. OSM administrative boundaries frequently
carry a bilingual `name`, so Rabat's prefecture arrives as `Prefecture de Rabat`
followed by the same text in Arabic, which is not something to show in a result
list. A locality that the label already contains is dropped, matching the
Geoapify behaviour it replaces, so `Casablanca` does not render as
`Casablanca, Casablanca`.

Counted in the FINISHED database, against its 3,608,008 rows. The enrichment
stage reports slightly higher numbers because it runs before deduplication, when
border-overlapping features still appear once per regional extract.

| Measure | Count | Share |
| --- | --- | --- |
| Records with a subdivision code | 3,559,941 | 98.7% |
| Records with a country code | 3,586,332 | 99.4% |

Codes come from the same `boundary=administrative` polygons at admin_level 2-4
that the reverse archive uses, so forward and reverse search cannot report
different jurisdictions for the same place. The country is derived FROM the
subdivision code rather than a country tag on the same polygon: Puerto Rico's
boundary carries both `ISO3166-2=US-PR` and `ISO3166-1=PR`, so trusting the tag
yields `PR` where eBird needs `US`. The ISO pattern is character-for-character
the one in `functions/lib/osm-places.ts`.

The join uses Shapely's STRtree. A hand-rolled 1-degree grid measured out at
roughly six hours for the global corpus, because country polygons are large
enough that a coarse cell holds hundreds of them and the point-in-ring test was
interpreted Python. It uses `covers` rather than `contains`, since `contains`
excludes the boundary and the record builder deliberately returns boundary
vertices for lines.

## Importance

| Measure | Count | Share |
| --- | --- | --- |
| Records carrying a QID | 582,119 | 16.1% |
| Records carrying importance | 386,873 | 10.7% |
| QIDs matched in the table | | 66.5% |

Joined at load time from the same `qid-importance.tsv` the reverse archive uses,
so a place cannot rank differently in forward and reverse search.

OSM's own free-text `importance` tag is ignored entirely. It carries values like
`national`, `regional` and one reading `Bulgarian 100`, and accepting a
numeric-looking one made it authoritative and blocked the QID join for that
record.

## Category distribution

water 974,728 · park 693,454 · lodging 398,742 · admin 376,953 ·
natural-other 362,073 · landuse 257,840 · place 178,464 · poi 87,920 ·
region 63,247 · landmark 54,748 · garden 42,779 · protected 40,620 ·
tourism-other 33,854 · golf-course 29,958 · attraction 12,628

Inclusion and these labels are GENERATED from `scoreOf()` and `kindOf()` in
`functions/lib/place-rank.ts` rather than restated, so forward and reverse
search cannot disagree about what a birding place is. `place-contract.ts`
parses the real if-chain into an ordered rule list and
`place-contract.test.ts` proves the parse against the live functions over
thousands of randomised multi-tag features, in both TypeScript and the Python
that consumes the artifact.

That matters because the first version hand-copied the rules and had already
drifted: `museum` scored 26 instead of 19 and `city` 20 instead of 14, so an
earlier version of this document reported a distribution containing category
names `kindOf` never emits.

## Integrity

A malformed record FAILS the enrichment stage rather than being skipped.
A silent `continue` there let TSV corruption or a producer schema change yield a
partial, or even empty, corpus while the pipeline still wrote its `DONE` marker,
so an incomplete database could be published as a successful rebuild.

Zero duplicate stable IDs, zero out-of-bounds coordinates, zero empty labels or
aliases.

Regional extracts OVERLAP at borders, so a feature straddling Europe and Asia
appears in both files with the same stable id. Deduplication happens at load
time, because no single region can see the collision.

Closed ways were also exported twice, once as an area and once as a linestring,
which is osmium's documented behaviour when `area_tags` and `linear_tags` are
both on. Europe alone had 1,101,405 duplicate ids. Reusing the reverse
pipeline's linear-tag list fixed it.

## Representative points

A search result needs one coordinate and it must lie ON the feature. A centroid
does not: for a C-shaped bay or a reserve with a lake cut out of it, the
centroid falls outside the polygon, so "take me here" points at the notch.

Polygons use a scanline point-on-surface that subtracts holes, tried at several
vertical offsets. Lines use the midpoint VERTEX, so the point is always a
position a mapper actually placed.

`test_representative_point.py` covers a square, a C shape, a donut, a thin-rim
donut, a two-hole polygon, a multipolygon and a line, asserting containment with
an independent even-odd test rather than against recorded output. An earlier
version ignored holes and returned the centre of the hole for a donut, which the
original C-shape-only fixture could not detect.

## Negative control

Addresses must not be searchable. `98115` returns 0 hits and `10 downing`
returns 1, a named feature rather than a house number. `main street` returns
197, all named places containing those words, such as parks and hotels, because
the upstream `FILTER` never selects `highway=*`.

## Reproducing

```bash
scripts/osm-places/run-full-pipeline.sh
```

Runs the admin-boundary export when needed, then the record export, the region
enrichment and the database build, holding an exclusive lock for the whole run.
`WORK`, `SRC`, `FCACHE` and the helper paths are overridable.

The record export reads the **cached filtered PBFs** that the reverse build
already produced, so it costs no re-filtering of the 84 GB source. A full global
run is about 90 minutes, dominated by Europe and by the region join.
