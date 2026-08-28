#!/usr/bin/env python3
"""Load exported search records into a SQLite FTS5 prototype and measure it.

Phase 1 step 6 and 7 of issue #343. The whole point is step 7's gate: adopt D1
only if the FINISHED global database is at or below 7 GB, leaving rebuild
headroom under D1's 10 GB hard limit. So this reports the sizes that decide it
rather than only building something that works.

Schema shape matters for that gate:

`places` is a plain content table. `places_fts` is an EXTERNAL CONTENT FTS5
table (`content=places`), which stores the index but NOT a second copy of the\ntext. Letting FTS5 own its own copy would roughly double the text bytes for no
benefit, and text is the bulk of this dataset.

`detail=none` drops the per-position offsets FTS5 keeps for phrase and NEAR
queries. Forward search here is prefix matching on short place names, so those
offsets are pure weight. This is measured rather than assumed: the script
reports the saving so the tradeoff is visible.
"""
from __future__ import annotations

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
  country  TEXT
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
  detail=none
);
INSERT INTO places_fts(rowid, alias) SELECT id, alias FROM places;
"""


def fts_query(q: str) -> str:
    """Build the FTS5 MATCH expression for a SUBMITTED query.

    Every token is exact EXCEPT the last, which keeps a trailing `*`.

    That split is deliberate. #343 requires token-prefix matching, so a
    submitted partial name like `discover par` has to find Discovery Park. But
    a star on EVERY token is what made the slow queries slow: `"park"*` matches
    231,558 rows and costs 42 ms alone, against 6.9 ms for exact `park`.

    Starring only the final token keeps prefix search working where a user
    actually stops typing, while the earlier tokens stay cheap and narrow the
    candidate set first. Measured on the golden set, this recovers most of the
    all-exact speed and still answers partial queries.
    """
    tokens = [t for t in q.split() if t]
    if not tokens:
        return ""
    head = " ".join(f'"{t}"' for t in tokens[:-1])
    tail = f'"{tokens[-1]}"*'
    return f"{head} {tail}".strip()


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n / (1024 ** ('B KB MB GB'.split().index(unit))):.2f} {unit}" if unit != "B" else f"{n} B"
        n_next = n
    return str(n)


def size(path: str) -> int:
    return os.path.getsize(path) if os.path.exists(path) else 0


def fmt(n: int) -> str:
    return f"{n / 1024 ** 3:.3f} GB ({n:,} bytes)"


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
    batch = []
    enriched = 0
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            # 9 fields is the raw export; 11 adds the offline region codes from
            # `enrich-search-regions.py`. Accepting only one of the two meant an
            # enriched build silently imported ZERO rows.
            if len(parts) == 9:
                parts = parts + ["", ""]
            elif len(parts) != 11:
                continue
            osm_id, label, lat, lon, score, kind, imp, qid, alias, state, country = parts
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
                          imp_val, qid or None, alias, state or None, country or None))
            if len(batch) >= 50_000:
                db.executemany(
                    "INSERT OR IGNORE INTO places(osm_id,label,lat,lon,score,kind,imp,qid,alias,state,country)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?)", batch)
                rows += len(batch)
                batch.clear()
    if batch:
        db.executemany(
            "INSERT OR IGNORE INTO places(osm_id,label,lat,lon,score,kind,imp,qid,alias,state,country)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)", batch)
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
    db.execute(
        "INSERT INTO place_alias(place_id, alias)"
        " WITH split(id, one, rest) AS ("
        "   SELECT id, '', alias || ' ' FROM places"
        "   UNION ALL"
        "   SELECT id, substr(rest, 1, instr(rest, ' ') - 1), substr(rest, instr(rest, ' ') + 1)"
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
    dupes = cur.execute("SELECT COUNT(*) FROM (SELECT osm_id FROM places GROUP BY osm_id HAVING COUNT(*)>1)").fetchone()[0]
    oob = cur.execute("SELECT COUNT(*) FROM places WHERE lat<-90 OR lat>90 OR lon<-180 OR lon>180").fetchone()[0]
    noname = cur.execute("SELECT COUNT(*) FROM places WHERE label='' OR alias=''").fetchone()[0]
    withimp = cur.execute("SELECT COUNT(*) FROM places WHERE imp IS NOT NULL").fetchone()[0]
    withqid = cur.execute("SELECT COUNT(*) FROM places WHERE qid IS NOT NULL").fetchone()[0]
    print(f"  duplicate osm_id     {dupes:,}")
    print(f"  out-of-bounds coords {oob:,}")
    print(f"  empty label/alias    {noname:,}")
    print(f"  carrying a QID       {withqid:,} ({100*withqid/max(rows,1):.1f}%)")
    print(f"  carrying importance  {withimp:,} ({100*withimp/max(rows,1):.1f}%)"
          f"  [{100*withimp/max(withqid,1):.1f}% of QIDs matched]")

    print(f"\n=== golden queries (p50 / p95 over 20 runs, top hit) ===")
    golden = ["discovery park", "central park", "union bay", "donana",
              "carkeek", "skagit", "tokyo", "sydney", "serengeti", "st martin",
              # Partial input: #343 requires token-prefix matching, so this has
              # to find Discovery Park.
              "discover par"]
    # Mirrors SEARCH_SQL in functions/lib/place-search.ts EXACTLY, including the
    # bounded candidate stage and the ORDERED exact arm. A bare `LIMIT 5` after
    # the full ordering measures a query that does not ship, and an unordered
    # cap on the exact arm measures an arbitrary subset for any name with more
    # than the cap in exact matches.
    sql = (
        "WITH candidates AS ("
        "  SELECT f.rowid AS id, rank AS fts_rank FROM places_fts f"
        "  WHERE places_fts MATCH ?2 ORDER BY rank LIMIT ?3"
        "), exact AS ("
        "  SELECT a.place_id AS id, 0.0 AS fts_rank FROM place_alias a"
        "  JOIN places pe ON pe.id = a.place_id"
        "  WHERE a.alias = ?1"
        "  ORDER BY pe.score DESC, COALESCE(pe.imp,0) DESC, pe.osm_id LIMIT ?3"
        "), pool AS ("
        "  SELECT id, MIN(fts_rank) AS fts_rank FROM"
        "  (SELECT * FROM candidates UNION ALL SELECT * FROM exact) GROUP BY id"
        ") SELECT p.label, p.kind, p.score FROM pool JOIN places p ON p.id=pool.id "
        "ORDER BY (EXISTS (SELECT 1 FROM place_alias a WHERE a.place_id=p.id AND a.alias=?1)) DESC, "
        "pool.fts_rank, p.score DESC, COALESCE(p.imp,0) DESC, p.osm_id LIMIT ?4"
    )
    for q in golden:
        term = fts_query(q)
        times = []
        top = None
        for _ in range(20):
            s = time.perf_counter()
            hits = cur.execute(sql, (q, term, 200, 5)).fetchall()
            times.append((time.perf_counter() - s) * 1000)
            top = hits[0] if hits else None
        times.sort()
        p50, p95 = times[len(times)//2], times[int(len(times)*0.95)]
        label = f"{top[0]} ({top[1]})" if top else "NO RESULT"
        print(f"  {q:<16} p50 {p50:7.2f} ms  p95 {p95:7.2f} ms   -> {label}")

    print(f"\n=== negative control: addresses must NOT be searchable ===")
    for q in ["main street", "10 downing", "98115"]:
        term = " ".join(f'"{t}"*' for t in q.split())
        n = cur.execute("SELECT COUNT(*) FROM places_fts WHERE places_fts MATCH ?", (term,)).fetchone()[0]
        print(f"  {q:<16} {n:,} hits")

    db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
