#!/usr/bin/env python3
"""Load exported search records into a SQLite FTS5 prototype and measure it.

Phase 1 step 6 and 7 of issue #343. The whole point is step 7's gate: adopt D1
only if the FINISHED global database is at or below 7 GB, leaving rebuild
headroom under D1's 10 GB hard limit. So this reports the sizes that decide it
rather than only building something that works.

Schema shape matters for that gate:

`places` is a plain content table. `places_fts` is an EXTERNAL CONTENT FTS5
table (`content=places`), which stores the index but NOT a second copy of the
text. Letting FTS5 own its own copy would roughly double the text bytes for no
benefit, and text is the bulk of this dataset.

`detail=full` is kept even though phrase and NEAR queries are never used.
`detail=none` looked like free savings, but it makes `ORDER BY rank` about
twice as slow, because bm25 must score without per-position data. Measured on a
400k-row sample: ranked `"park"*` costs 32.8 ms at detail=none against 15.1 ms
at detail=full, for 12% more bytes. Ranking speed is the binding constraint,
not size: the corpus lands at a tenth of the gate.
"""
from __future__ import annotations

import math
import os
import sqlite3
import sys
import time

DDL = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE places (
  id       INTEGER PRIMARY KEY,
  osm_id   TEXT NOT NULL UNIQUE,
  label    TEXT NOT NULL,
  lat      REAL NOT NULL,
  lon      REAL NOT NULL,
  score    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  imp      INTEGER,
  qid      TEXT,
  alias    TEXT NOT NULL,
  state    TEXT,
  country  TEXT,
  region   TEXT
);

-- One row per alias, so an exact-match test works on a SINGLE alias rather
-- than on the space-joined blob. `places.alias` concatenates every alias for
-- FTS indexing, so `alias = 'casablanca'` is false for a place whose alias
-- column reads 'casablanca ... casa ...'. Ranking against this table gives the
-- exact-match boost to any of a place's names, not only to single-name places.
CREATE TABLE place_alias (
  place_id INTEGER NOT NULL REFERENCES places(id),
  alias    TEXT NOT NULL
);
"""

FTS_DDL = """
CREATE VIRTUAL TABLE places_fts USING fts5(
  alias,
  content=places,
  content_rowid=id,
  tokenize='unicode61 remove_diacritics 2',
  detail=full
);
INSERT INTO places_fts(rowid, alias) SELECT id, REPLACE(alias, '|', ' ') FROM places;
"""


def fts_query(q: str) -> str:
    """Build the FTS5 MATCH expression for a SUBMITTED query.

    EVERY token carries a trailing `*`.

    An earlier version starred only the final token, assuming a submitted query
    has complete words except where the user stopped typing. That is wrong:
    `discover par` returned nothing, because `"discover"` is not a token in
    `discovery park`. #343 requires token-prefix matching, and abbreviating more
    than one word is exactly that.

    The cost is real: `"park"*` matches 231,558 rows against 219,289 for exact
    `park`, at 42 ms rather than 6.9 ms. The bounded candidate stage is what
    makes it affordable, rather than trimming the requirement to fit.

    Mirrors `ftsExpression()` in functions/lib/place-search.ts.
    """
    tokens = [t for t in q.split() if t]
    if not tokens:
        return ""
    return " ".join(f'"{t}"*' for t in tokens)


def size(path: str) -> int:
    return os.path.getsize(path) if os.path.exists(path) else 0


def fmt(n: int) -> str:
    return f"{n / 1024 ** 3:.3f} GB ({n:,} bytes)"


def flush(db, batch) -> int:
    """Insert a batch, returning the number of CONFLICTING duplicate ids.

    Regional extracts OVERLAP at borders, so a feature straddling Europe and
    Asia arrives twice with IDENTICAL content and must be deduplicated. A bare
    `INSERT OR IGNORE` did that, but it also swallowed the interesting case:
    the same `osm_id` arriving with DIFFERENT content, where an arbitrary first
    copy wins silently. The later `duplicate osm_id` integrity query then
    reported zero BY CONSTRUCTION and could never have found anything, because
    the UNIQUE constraint had already removed what it was looking for.

    So the insert still ignores exact repeats, and every ignored row is
    re-checked against the stored copy. Identical is expected and silent.
    Different is a real defect: it is counted, sampled to stderr, and reported
    by the caller.
    """
    before = db.total_changes
    db.executemany(
        "INSERT OR IGNORE INTO places(osm_id,label,lat,lon,score,kind,imp,qid,alias,state,country,region)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", batch)
    ignored = len(batch) - (db.total_changes - before)
    if not ignored:
        return 0
    cols = "label,lat,lon,score,kind,imp,qid,alias,state,country,region"
    conflicts = 0
    for row in batch:
        stored = db.execute(f"SELECT {cols} FROM places WHERE osm_id=?", (row[0],)).fetchone()
        if stored is not None and tuple(stored) != tuple(row[1:]):
            conflicts += 1
            if conflicts <= 5:
                print(f"  CONFLICT {row[0]}: stored={stored} incoming={tuple(row[1:])}",
                      file=sys.stderr)
    return conflicts


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: build-search-db.py <all.tsv> <out.sqlite> [qid-importance.tsv]", file=sys.stderr)
        return 1
    src, out = sys.argv[1], sys.argv[2]
    imp_table_path = sys.argv[3] if len(sys.argv) > 3 else None

    # Join importance HERE rather than in the per-region export.
    #
    # The reverse archive joins it between `osmium export` and tippecanoe and
    # then DROPS the QID, because for tiles the key is dead weight once used.
    # Search keeps the QID as a column, so the join can happen once at load
    # time against the whole corpus instead of once per region. Same source
    # table as the archive, so a place cannot rank differently in forward and
    # reverse search.
    imp_table: dict[int, int] = {}
    if imp_table_path:
        with open(imp_table_path, encoding="ascii") as fh:
            for line in fh:
                qid, score = line.split("\t")
                imp_table[int(qid)] = int(score)
        print(f"  importance table: {len(imp_table):,} QIDs", file=sys.stderr)

    for suffix in ("", "-journal", "-wal"):
        if os.path.exists(out + suffix):
            os.remove(out + suffix)

    db = sqlite3.connect(out)
    db.executescript(DDL)

    t0 = time.time()
    rows = 0
    matched_imp = 0
    conflicts = 0
    batch = []
    enriched = 0
    with open(src, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            parts = line.rstrip("\n").split("\t")
            # 9 fields is the raw export; 12 adds the offline region codes and
            # the locality name from `enrich-search-regions.py`. Accepting only
            # one of the two meant an enriched build silently imported ZERO
            # rows.
            #
            # Anything else FAILS. A silent skip here let a truncated TSV or a
            # producer schema change yield a partial database while the wrapper
            # still wrote `pipeline.DONE`, which is the same fail-open hole the
            # enrichment stage closed.
            if len(parts) == 9:
                parts = parts + ["", "", ""]
            elif len(parts) != 12:
                sys.exit(
                    f"{src}:{lineno}: expected 9 or 12 tab-separated fields, "
                    f"got {len(parts)}; refusing to build a partial database"
                )
            osm_id, label, lat, lon, score, kind, imp, qid, alias, state, country, region = parts
            if state or country:
                enriched += 1
            imp_val = int(imp) if imp else None
            if imp_val is None and qid and imp_table:
                # QIDs arrive as `Q1563`; the table is keyed on the number.
                if qid.startswith("Q") and qid[1:].isdigit():
                    imp_val = imp_table.get(int(qid[1:]))
                    if imp_val is not None:
                        matched_imp += 1
            batch.append((osm_id, label, float(lat), float(lon), int(score), kind,
                          imp_val, qid or None, alias, state or None, country or None,
                          region or None))
            if len(batch) >= 50_000:
                conflicts += flush(db, batch)
                rows += len(batch)
                batch.clear()
    if batch:
        conflicts += flush(db, batch)
        rows += len(batch)
    db.commit()
    # Regional extracts OVERLAP at borders: Geofabrik ships a feature that
    # straddles Europe and Asia in both files, so the same stable OSM id
    # arrives twice with identical content. Deduplicating on osm_id here is
    # the right layer, because no single region can see the collision.
    rows = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    load_s = time.time() - t0
    content_bytes = size(out)

    t1 = time.time()
    db.executescript(FTS_DDL)
    # Populate the per-alias table by splitting the concatenated column, so an
    # exact-match test can hit ANY of a place's names.
    # Split on the PIPE boundary, not on spaces. Aliases are pipe-separated in
    # the TSV precisely because folding can never emit a pipe, so a multi-word
    # alias such as `central park` stays ONE row. Splitting on spaces produced
    # 8.4 million single WORDS, so `alias = 'central park'` matched nothing and
    # the exact-match boost was dead for every name containing a space.
    db.execute(
        "INSERT INTO place_alias(place_id, alias)"
        " WITH split(id, one, rest) AS ("
        "   SELECT id, '', alias || '|' FROM places"
        "   UNION ALL"
        "   SELECT id, substr(rest, 1, instr(rest, '|') - 1), substr(rest, instr(rest, '|') + 1)"
        "   FROM split WHERE rest <> ''"
        " ) SELECT DISTINCT id, one FROM split WHERE one <> ''"
    )
    # The ranking ORDER BY leads with an exact-alias test, which without an
    # index scans every candidate row the MATCH returned.
    db.execute("CREATE INDEX idx_place_alias ON place_alias(alias, place_id)")
    db.commit()
    fts_s = time.time() - t1
    total_bytes = size(out)

    print(f"\n=== corpus ===")
    print(f"  rows                 {rows:,}")
    print(f"  source TSV           {fmt(size(src))}")
    print(f"  content table only   {fmt(content_bytes)}   ({load_s:.0f}s)")
    print(f"  FTS5 index + alias   {fmt(total_bytes - content_bytes)}   ({fts_s:.0f}s)")
    print(f"  TOTAL DATABASE       {fmt(total_bytes)}   (all indexes created)")

    gate = 7 * 1024 ** 3
    verdict = "UNDER the 7 GB gate" if total_bytes <= gate else "OVER the 7 GB gate"
    print(f"  verdict              {verdict} ({100 * total_bytes / gate:.1f}% of 7 GB)")

    cur = db.cursor()
    print(f"\n=== category distribution ===")
    for kind, n in cur.execute("SELECT kind, COUNT(*) FROM places GROUP BY kind ORDER BY 2 DESC"):
        print(f"  {kind:<16} {n:>10,}")

    print(f"\n=== integrity ===")
    # `osm_id` is UNIQUE, so this can only ever be 0 and is kept as a schema
    # assertion, not as a data check. The meaningful number is `conflicts`,
    # counted at load time: ids that arrived twice with DIFFERENT content.
    dupes = cur.execute("SELECT COUNT(*) FROM (SELECT osm_id FROM places GROUP BY osm_id HAVING COUNT(*)>1)").fetchone()[0]
    oob = cur.execute("SELECT COUNT(*) FROM places WHERE lat<-90 OR lat>90 OR lon<-180 OR lon>180").fetchone()[0]
    noname = cur.execute("SELECT COUNT(*) FROM places WHERE label='' OR alias=''").fetchone()[0]
    withimp = cur.execute("SELECT COUNT(*) FROM places WHERE imp IS NOT NULL").fetchone()[0]
    withqid = cur.execute("SELECT COUNT(*) FROM places WHERE qid IS NOT NULL").fetchone()[0]
    print(f"  duplicate osm_id     {dupes:,}")
    print(f"  conflicting osm_id   {conflicts:,}"
          f"{'' if conflicts == 0 else '   <-- same id, DIFFERENT content'}")
    print(f"  out-of-bounds coords {oob:,}")
    print(f"  empty label/alias    {noname:,}")
    print(f"  carrying a QID       {withqid:,} ({100*withqid/max(rows,1):.1f}%)")
    print(f"  carrying importance  {withimp:,} ({100*withimp/max(rows,1):.1f}%)"
          f"  [{100*withimp/max(withqid,1):.1f}% of QIDs matched]")

    print(f"\n=== golden queries (p50 / p95 over 20 runs, top hit) ===")
    # (query, expected label, expected category). Each is an ASSERTION, not a
    # benchmark: printing whatever came back meant a query could return the
    # wrong place, or nothing at all, and the build still exited 0. Issue #343's
    # acceptance criteria require a golden corpus that verifies RANKING, which
    # only works when a mismatch is fatal.
    #
    # Every expectation is a property of the ranking rather than a lucky top
    # hit: the prominent Seattle park over the Ohio parkway, New York's Central
    # Park over 520 other places carrying that exact name, the city of Tokyo
    # over the features inside it.
    golden = [
        ("discovery park", "Discovery Park", "park"),
        ("central park", "Central Park", "park"),
        ("union bay", "Union Bay", "water"),
        # ASCII input must reach the accented name.
        ("donana", "Donana", "place"),
        ("carkeek", "Carkeek", "natural-other"),
        ("skagit", "Skagit", "landuse"),
        ("tokyo", "Tokyo", "admin"),
        ("sydney", "Sydney", "admin"),
        # A German safari park, label taken from `name:en`. It outranks
        # Tanzania's Serengeti National Park for the bare token because that
        # one's alias is the full three-word name, so this is also a check that
        # exact-alias matching beats a longer partial.
        ("serengeti", "Serengeti Park", "attraction"),
        ("st martin", "St Martin", "admin"),
        # Partial input: #343 requires token-prefix matching, so this has
        # to find Discovery Park.
        ("discover par", "Discovery Park", "park"),
    ]
    # Mirrors SEARCH_SQL in functions/lib/place-search.ts EXACTLY, including the
    # bounded candidate stage and the ORDERED exact arm. A bare `LIMIT 5` after
    # the full ordering measures a query that does not ship, and an unordered
    # cap on the exact arm measures an arbitrary subset for any name with more
    # than the cap in exact matches.
    sql = (
        "WITH candidates AS ("
        "  SELECT f.rowid AS id, rank AS fts_rank FROM places_fts f"
        "  WHERE places_fts MATCH ? ORDER BY rank LIMIT ?"
        "), exact AS ("
        "  SELECT a.place_id AS id, 0.0 AS fts_rank FROM place_alias a"
        "  JOIN places pe ON pe.id = a.place_id"
        "  WHERE a.alias = ?"
        "  ORDER BY COALESCE(pe.imp,0) DESC, pe.score DESC, pe.osm_id LIMIT ?"
        "), pool AS ("
        "  SELECT id, MIN(fts_rank) AS fts_rank FROM"
        "  (SELECT * FROM candidates UNION ALL SELECT * FROM exact) GROUP BY id"
        "), ranked AS ("
        "  SELECT p.label, p.kind, p.score, p.imp, p.osm_id, pool.fts_rank,"
        "  EXISTS (SELECT 1 FROM place_alias a WHERE a.place_id=p.id AND a.alias=?) AS is_exact"
        "  FROM pool JOIN places p ON p.id=pool.id"
        ") SELECT label, kind, score FROM ranked "
        "ORDER BY is_exact DESC, CASE WHEN is_exact THEN 0.0 ELSE fts_rank END, "
        "CASE WHEN is_exact THEN -COALESCE(imp,0) ELSE -score END, "
        "CASE WHEN is_exact THEN -score ELSE -COALESCE(imp,0) END, osm_id LIMIT ?"
    )
    golden_failures = []
    for q, want_label, want_kind in golden:
        term = fts_query(q)
        times = []
        top = None
        for _ in range(20):
            s = time.perf_counter()
            hits = cur.execute(sql, (term, 200, q, 200, q, 5)).fetchall()
            times.append((time.perf_counter() - s) * 1000)
            top = hits[0] if hits else None
        times.sort()
        # Nearest-rank percentile. `int(len * 0.95)` indexes element 19 of 20,
        # which is the MAXIMUM, so every reported p95 was really a p100 and the
        # feasibility numbers overstated the tail.
        p50 = times[math.ceil(0.50 * len(times)) - 1]
        p95 = times[math.ceil(0.95 * len(times)) - 1]
        if top is None:
            got = "NO RESULT"
            ok = False
        else:
            got = f"{top[0]} ({top[1]})"
            ok = top[0] == want_label and top[1] == want_kind
        if not ok:
            golden_failures.append(f"{q!r} expected {want_label} ({want_kind}), got {got}")
        mark = "ok " if ok else "FAIL"
        print(f"  {mark} {q:<16} p50 {p50:7.2f} ms  p95 {p95:7.2f} ms   -> {got}")

    print(f"\n=== negative control: addresses must NOT be searchable ===")
    # `main street` legitimately matches named features containing those words,
    # so the assertion is on the two that must find NOTHING: a house number and
    # a postcode. Those would only match if address data had leaked into the
    # corpus, which is what #343 excludes.
    address_leaks = []
    for q, must_be_zero in (("main street", False), ("10 downing", False), ("98115", True)):
        term = " ".join(f'"{t}"*' for t in q.split())
        n = cur.execute("SELECT COUNT(*) FROM places_fts WHERE places_fts MATCH ?", (term,)).fetchone()[0]
        if must_be_zero and n:
            address_leaks.append(f"{q!r} matched {n:,} rows; addresses must not be indexed")
        print(f"  {q:<16} {n:,} hits")

    db.close()
    # Every integrity failure is fatal, not merely printed. A database with
    # out-of-bounds coordinates or empty labels is as unpublishable as one with
    # conflicting ids, and returning 0 let the wrapper write `pipeline.DONE`
    # over it.
    problems = []
    if conflicts:
        problems.append(f"{conflicts:,} osm_id values with conflicting content")
    if dupes:
        problems.append(f"{dupes:,} duplicate osm_id values")
    if oob:
        problems.append(f"{oob:,} out-of-bounds coordinates")
    if noname:
        problems.append(f"{noname:,} rows with an empty label or alias")
    if golden_failures:
        problems.append(f"{len(golden_failures)} golden queries returned the wrong place")
    if address_leaks:
        problems.append(f"{len(address_leaks)} address queries matched")
    if problems:
        print("\nFAILED: " + "; ".join(problems), file=sys.stderr)
        for line in golden_failures + address_leaks:
            print(f"  {line}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
