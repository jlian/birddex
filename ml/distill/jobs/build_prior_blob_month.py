#!/usr/bin/env python3
"""Build the month-aware occurrence prior blob (WDOP v3).

v2 keyed the index by cell. v3 keys it by (cell, month), so the client does the
same binary search and gets back exactly the slice it needs. Nothing else about
the format changes: same varint species deltas, same one-byte quantised log
probability, same taxonomy hash guard, same whole-file gzip.

The probability stored is P(species | cell, month) = n_scm / n_cm, which is what
G16 fitted. The backoff term k fits to zero, so there is no blending to encode.

KEY LAYOUT. A cell id already packs into 32 bits as row * 1276 + col, with
618 * 1276 = 788,568 possible cells, needing 20 bits. Month needs 4. So the key
is (cell_id << 4) | (month - 1), which stays inside uint32 and keeps the index
sorted by cell then month. That ordering matters: a client wanting a fallback
can find the 12 months of one cell contiguously.

SIZE. v2 shipped 3,176,965 pairs in 5.41 MiB gzipped. Splitting by month",
"multiplies the entry count, so --min-count is the lever against the 25 MiB
per-file cap. Every dropped entry falls back to the absence floor client-side.
"""
import argparse
import gzip
import hashlib
import json
import math
import struct
import time

import duckdb

MAGIC = b"WDOP"
VERSION = 3
QBITS = 5
QMAX = (1 << QBITS) - 1
SCALE = 2.5
GRID_COLS = 1276
MONTH_BITS = 4


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True,
                    help="occurrence_month.parquet with row, col, taxon_id, mon, n")
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--taxonomy", required=True,
                    help="src/lib/taxonomy.json, hashed into the header")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-count", type=int, default=1)
    args = ap.parse_args()

    tx = open(args.taxonomy, "rb").read()
    tx_hash = hashlib.sha256(tx).digest()[:8]
    log("taxonomy sha256[:8] = " + tx_hash.hex())

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "12GB" + chr(39))
    con.execute("CREATE TEMP TABLE birds AS SELECT "
                "CAST(inat_taxon_id AS BIGINT) tid, CAST(app_idx AS INTEGER) idx "
                "FROM read_csv(" + chr(39) + args.target_taxa + chr(39) +
                ", header=true, all_varchar=true)")
    nb = con.execute("SELECT count(*) FROM birds").fetchone()[0]
    log(str(nb) + " bird taxa in taxonomy")

    con.execute("CREATE TEMP TABLE occ AS SELECT o.row, o.col, o.mon, b.idx, o.n "
                "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ") o "
                "JOIN birds b ON o.taxon_id = b.tid WHERE o.n >= " +
                str(args.min_count))
    # Totals are per (cell, month), matching n_cm in the fitted equation.
    con.execute("CREATE TEMP TABLE tot AS SELECT row, col, mon, sum(n) t "
                "FROM occ GROUP BY 1,2,3")
    rows = con.execute("SELECT o.row, o.col, o.mon, o.idx, o.n, t.t FROM occ o "
                       "JOIN tot t ON o.row=t.row AND o.col=t.col AND o.mon=t.mon "
                       "ORDER BY o.row, o.col, o.mon, o.idx").fetchall()
    log(str(len(rows)) + " (species,cell,month) triples after bird filter")

    payload = bytearray()
    index = []
    cur_key = None
    prev_idx = 0
    nslices = 0
    for rw, cl, mo, idx, n, t in rows:
        cell = rw * GRID_COLS + cl
        key = (cell << MONTH_BITS) | (int(mo) - 1)
        if key != cur_key:
            index.append((key, len(payload)))
            cur_key = key
            prev_idx = 0
            nslices += 1
        p = max(n / max(t, 1), 1e-9)
        q = int(max(0, min(QMAX, round(-math.log(p) * SCALE))))
        payload += varint(idx - prev_idx)
        prev_idx = idx
        payload.append(q)
    log(str(nslices) + " (cell,month) slices, payload " +
        str(len(payload)) + " B")

    index.sort(key=lambda x: x[0])
    head = bytearray()
    head += MAGIC
    head += bytes([VERSION, QBITS, MONTH_BITS, 0])
    head += tx_hash
    head += struct.pack("<I", len(index))
    for key, off in index:
        head += struct.pack("<II", key, off)
    head += struct.pack("<II", 0xFFFFFFFF, len(payload))

    blob = bytes(head) + bytes(payload)
    gz = gzip.compress(blob, 9)

    # Name by CONTENT. The assets are served immutable for a year, so a fixed
    # name would hand a stale blob to every existing user after a rebuild, and
    # a schema number in the URL leaks an internal detail that changes for
    # reasons users do not care about.
    digest = hashlib.sha256(gz).hexdigest()[:8]
    out = args.out.replace("HASH", digest)
    open(out, "wb").write(gz)
    log("raw  %.2f MiB" % (len(blob) / 1048576.0))
    log("gzip %.2f MiB" % (len(gz) / 1048576.0))
    cap = 25 * 1024 * 1024
    if len(gz) > cap:
        log("OVER the 25 MiB per-file cap by %.2f MiB. Raise --min-count." %
            ((len(gz) - cap) / 1048576.0))
    else:
        log("under the 25 MiB cap with %.2f MiB to spare" %
            ((cap - len(gz)) / 1048576.0))

    meta = {"magic": "WDOP", "version": VERSION, "qbits": QBITS,
            "month_bits": MONTH_BITS, "scale": SCALE, "grid_cols": GRID_COLS,
            "taxonomy_sha256_8": tx_hash.hex(),
            "n_slices": len(index), "n_triples": len(rows),
            "min_count": args.min_count,
            "raw_bytes": len(blob), "gzip_bytes": len(gz),
            "content_hash": digest}
    json.dump(meta, open(out + ".meta.json", "w"), indent=2)
    log("wrote " + out)
    log("content hash: " + digest)
    print("=== BLOB v3 BUILD DONE ===")


if __name__ == "__main__":
    main()
