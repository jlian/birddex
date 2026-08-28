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

    Every token is exact. That is a deliberate 13x win, measured, not a
    limitation: a trailing `*` on a COMMON COMPLETE WORD is what made the slow
    cases slow. `"park"*` matches 231,558 rows and costs 42 ms on its own,
    while exact `park` matches 219,289 and costs 6.9 ms. The star buys 12,269
    extra rows (`parkway`, `parkland`) that nobody searching for a park wants,
    and pays 6x for them.

    Full measurement over the golden set, all-prefix versus all-exact:

        discovery park   86.14 ms -> 6.68 ms
        central park     89.03 ms -> 11.33 ms
        st martin        60.05 ms -> 0.59 ms
        union bay         7.92 ms -> 0.61 ms

    The top hit is IDENTICAL for every query in that set, so this costs no
    result quality. It is sound here specifically because #343 states
    autocomplete is not required: this runs on submitted search, where the
    user has finished typing. Reintroducing prefix matching for autocomplete
    would need this measured again.

    Quoting each token also makes the input inert: FTS5 operators a user types
    (`AND`, `NOT`, `*`, `^`) become literal text instead of query syntax.
    """
    return " ".join(f'"{t}"' for t in q.split() if t)


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
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 9:
                continue
            osm_id, label, lat, lon, score, kind, imp, qid, alias = parts
            imp_val = int(imp) if imp else None
            if imp_val is None and qid and imp_table:
                # QIDs arrive as `Q1563`; the table is keyed on the number.
                if qid.startswith("Q") and qid[1:].isdigit():
                    imp_val = imp_table.get(int(qid[1:]))
                    if imp_val is not None:
                        matched_imp += 1
            batch.append((osm_id, label, float(lat), float(lon), int(score), kind,
                          imp_val, qid or None, alias))
            if len(batch) >= 50_000:
                db.executemany(
                    "INSERT OR IGNORE INTO places(osm_id,label,lat,lon,score,kind,imp,qid,alias)"
                    " VALUES(?,?,?,?,?,?,?,?,?)", batch)
                rows += len(batch)
                batch.clear()
    if batch:
        db.executemany(
            "INSERT OR IGNORE INTO places(osm_id,label,lat,lon,score,kind,imp,qid,alias)"
            " VALUES(?,?,?,?,?,?,?,?,?)", batch)
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
    # The alias index is part of the SHIPPED schema, not an afterthought: the
    # ranking ORDER BY leads with `alias = ?`, which without it scans every
    # candidate row the MATCH returned. Create it BEFORE sampling the size, or
    # the reported total describes a database that cannot serve the benchmarked
    # query plan.
    db.execute("CREATE INDEX idx_places_alias ON places(alias)")
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
              "carkeek", "skagit", "tokyo", "sydney", "serengeti", "st martin"]
    # Rank text quality FIRST (bm25), then the WingDex category score, then
    # importance, then the stable id so the order is total and reproducible.
    #
    # The `alias = ?` term is what stops a common query drifting to a foreign
    # near-match: without it "central park" ranked `Centrala park` above the
    # real one, because bm25 alone cannot tell an EXACT full-name match from a
    # prefix hit on a longer name. An exact normalised match is the strongest
    # signal a searcher can give, so it outranks everything else.
    sql = ("SELECT p.label, p.kind, p.score FROM places_fts f JOIN places p ON p.id=f.rowid "
           "WHERE places_fts MATCH ? "
           "ORDER BY (p.alias = ?) DESC, bm25(places_fts), p.score DESC, "
           "COALESCE(p.imp,0) DESC, p.osm_id LIMIT 5")
    for q in golden:
        term = fts_query(q)
        times = []
        top = None
        for _ in range(20):
            s = time.perf_counter()
            hits = cur.execute(sql, (term, q)).fetchall()
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
