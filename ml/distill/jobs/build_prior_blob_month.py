#!/usr/bin/env python3
"""Build the month-aware occurrence prior blob (WDOP v3 and v4).

v2 keyed the index by cell. v3 keys it by (cell, month), so the client does the
same binary search and gets back exactly the slice it needs. Nothing else about
the format changes: same varint species deltas, same one-byte quantised log
probability, same taxonomy hash guard, same whole-file gzip.

v3 stores P(species | cell, month) = n_scm / n_cm. That is a NORMALISED value,
and normalisation is lossy in a way that matters: n_cm is divided out and never
written down, so the client cannot recover the counts. Any Dirichlet-multinomial
backoff

    P(s | c, m) = (n_scm + k * P(s | c)) / (n_cm + k)

is therefore impossible to apply on the client against a v3 blob. The only way
to get backoff with v3 is to bake a chosen k into the stored probability at
build time, which (a) makes every cell-month slice dense, because every species
in the pooled slice acquires a non-zero probability in every month, and (b)
freezes k into the asset, so retuning it means rebuilding and re-downloading
the whole blob.

v4 fixes this by writing down the two things v3 threw away, and nothing else:

  1. A POOLED slice per cell, holding P(species | cell), stored under the
     reserved month code 12.
  2. n_cm per index entry, in a flat table parallel to the index.

k stays a CLIENT constant. The blob is k-agnostic, so k can be retuned by
shipping a new client build against the same cached asset.

FILE LAYOUT (v4; v3 is the same minus the totals table and the pooled slices)

    offset  size            field
    0       4               magic "WDOP"
    4       1               version (3 or 4)
    5       1               qbits (5)
    6       1               month_bits (4)
    7       1               reserved, 0
    8       8               taxonomy sha256[:8]
    16      4               n_index (uint32 LE)
    20      (n_index+1)*8   index: (uint32 key, uint32 payload_offset) pairs,
                            sorted by key, plus a terminating sentinel pair
                            (0xFFFFFFFF, len(payload)) so slice extent is
                            always index[i+1].offset - index[i].offset
    T       n_index*4       V4 ONLY: totals, uint32 LE, ONE PER INDEX ENTRY in
                            index order. totals[i] is n_cm for a monthly slice,
                            or n_c for a pooled slice.
    P       ...             payload: per slice, a run of (varint species-index
                            delta, 1 byte quantised -log(p) * SCALE)

    T = 20 + (n_index+1)*8
    P = T                      for v3
    P = T + n_index*4          for v4

WHY THE TOTALS TABLE IS PARALLEL, NOT KEYED. A keyed (key, n_cm) table would
need its own binary search and repeat the 4-byte key that the index already
holds. Every index entry has exactly one total, so storing them positionally
means the client reuses the array position the index search already produced
and pays no second lookup and no duplicated keys. It costs 4 bytes per slice
and needs no new count field in the header, because the length is n_index.

WHY MONTH CODE 12. Months are stored as (mon - 1), so a 4-bit month field uses
0..11 and codes 12..15 are unused. Verified against the source data: mon ranges
1..12 exactly, so 12 is free. Using a reserved code inside the existing key
means the pooled slice is found by the SAME binary search, with no second index
and no format branch in the hot path. Cell ids stay inside uint32: the largest
observed cell is 617 * 1276 + 1271 = 788,563, so (788563 << 4) | 12 = 12,617,020,
far below 2^32. Sort order is unchanged, so a cell's twelve months and its
pooled slice remain contiguous.

WHY n_scm IS NOT STORED DIRECTLY. It would need a varint per triple on top of
the quantised byte, roughly doubling the payload. The client recovers it as the
FRACTIONAL product p_hat * n_cm from the value already present. That
reconstruction inherits the 5-bit quantisation error, which is up to about 22%
relative on n_scm, but that same error is already present in the v3 probability
the ranker uses today, so backoff adds no new error term. It is only a
reconstruction of a number the client was already trusting in ratio form.

WHY FRACTIONAL AND NOT round(p_hat * n_cm). An earlier version of this comment
said the client rounds. It does not, in either client: src/lib/rank.ts uses
Math.exp(lp) * nCM and ios BirdRanker.swift uses exp(lp) * nCM, both unrounded.
The fractional form is deliberate and must not be "tidied" into an integer
count. Rounding is a floor at 0.5, so every cell-month whose reconstructed
n_scm lands below that collapses to exactly 0 and the species is left with only
the k * p_pooled backoff term, or with nothing at all when it is absent from the
pooled slice too. Those thinly observed cell-months are precisely the cells this
format exists to rescue: quantising away the small mass is quantising away the
whole effect.

The calibration is fitted against the fractional form, not merely compatible
with it. T = 0.007435, beta = 1.1634, OCC_FLOOR = log(3e-5) and k = 0.3 were all
measured with fractional reconstruction in the loop, so switching to rounded
values invalidates every one of them. ANY future port must use the fractional
product, or refit all four constants against whatever it does instead.

SIZE. v2 shipped 3,176,965 pairs in 5.41 MiB gzipped. v3 ships 8,318,320
triples in 15.71 MiB gzipped. v4 adds the 3,176,965 pooled pairs (a 1.38x
triple count) plus one uint32 per slice, so --min-count remains the lever
against the 25 MiB per-file cap. Every dropped entry falls back to the absence
floor client-side.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import struct
import time

import duckdb

# Repo root, derived from this file rather than hardcoded, so the script
# works from a clone at any path.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))


def read_client_k(path):
    """OCC_BACKOFF_K from the web ranker: the k the app actually applies.

    The metadata field is provenance, so it must come from the code it
    claims to describe. Retyping it as a flag is how the shipped v4 blob
    came to record 1.0 while both rankers ran 0.3.
    """
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"OCC_BACKOFF_K\s*=\s*([0-9.eE+-]+)", src)
    if not m:
        raise SystemExit("no OCC_BACKOFF_K in " + path + "; pass --k "
                         "explicitly if the ranker moved it")
    return float(m.group(1))


MAGIC = b"WDOP"
VERSION = 3
VERSION_V4 = 4
QBITS = 5
QMAX = (1 << QBITS) - 1
SCALE = 2.5
GRID_COLS = 1276
MONTH_BITS = 4
# Months occupy codes 0..11 (stored as mon - 1), so 12..15 are free. The pooled
# per-cell slice takes 12. Asserted against the data below, not assumed.
POOLED_MONTH_CODE = 12


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


def quant(n, t):
    p = max(n / max(t, 1), 1e-9)
    return int(max(0, min(QMAX, round(-math.log(p) * SCALE))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True,
                    help="occurrence_month.parquet with row, col, taxon_id, mon, n")
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--taxonomy", required=True,
                    help="src/lib/taxonomy.json, hashed into the header")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-count", type=int, default=1)
    ap.add_argument("--v4", action="store_true",
                    help="emit v4: add the pooled per-cell slice and the n_cm "
                         "totals table, so the client can apply backoff. "
                         "Absent, the output is byte-for-byte v3.")
    ap.add_argument("--k", type=float, default=None,
                    help="RECORDED IN METADATA ONLY; it does not change a "
                         "single byte of the blob. k is a client constant "
                         "under v4, which is the entire point of the format: "
                         "retuning k must not require a rebuild. The flag "
                         "exists so a build can document the k it was intended "
                         "for. A non-zero k requires --v4, because a v3 blob "
                         "cannot express backoff at all. UNDER --v4 IT "
                         "DEFAULTS TO THE VALUE READ FROM --rank-ts, because "
                         "a hand-typed k is provenance that can be wrong: the "
                         "v4 blob shipped with 1.0 recorded while both rankers "
                         "ran 0.3. Without --v4 it defaults to 0.0, the only "
                         "value a v3 blob can honestly claim.")
    ap.add_argument("--rank-ts",
                    default=os.path.join(REPO_ROOT, "src", "lib", "rank.ts"),
                    help="Single source of truth for the client k. "
                         "OCC_BACKOFF_K in the web ranker is the shipped "
                         "value, and ios BirdRanker.swift occBackoffK "
                         "mirrors it. Read rather than retyped so the "
                         "metadata cannot drift from the code it describes.")
    args = ap.parse_args()

    if args.k is None:
        if args.v4:
            args.k = read_client_k(args.rank_ts)
            log("client k read from " + args.rank_ts + ": " + repr(args.k))
        else:
            # v3 cannot express backoff at all, so its only coherent default
            # is no backoff. Reading the client constant here would make every
            # plain v3 build trip the guard below, which broke mincount_sweep.
            args.k = 0.0

    if args.k != 0.0 and not args.v4:
        raise SystemExit("--k is meaningless without --v4: a v3 blob stores "
                         "only normalised probabilities, so the client cannot "
                         "apply any backoff. Pass --v4.")

    version = VERSION_V4 if args.v4 else VERSION

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

    # The reserved month code must actually be reserved. If the source ever
    # carries mon outside 1..12 the key packing silently collides with the
    # pooled slice, which is exactly the class of silent mis-keying the
    # taxonomy hash exists to prevent, so it is checked rather than assumed.
    mn, mx = con.execute("SELECT min(mon), max(mon) FROM occ").fetchone()
    if int(mn) < 1 or int(mx) > 12:
        raise SystemExit("mon out of range: " + str(mn) + ".." + str(mx) +
                         ", which collides with the reserved pooled code " +
                         str(POOLED_MONTH_CODE))

    # Totals are per (cell, month), matching n_cm in the fitted equation.
    con.execute("CREATE TEMP TABLE tot AS SELECT row, col, mon, sum(n) t "
                "FROM occ GROUP BY 1,2,3")
    rows = con.execute("SELECT o.row, o.col, o.mon, o.idx, o.n, t.t FROM occ o "
                       "JOIN tot t ON o.row=t.row AND o.col=t.col AND o.mon=t.mon "
                       "ORDER BY o.row, o.col, o.mon, o.idx").fetchall()
    log(str(len(rows)) + " (species,cell,month) triples after bird filter")

    pooled = []
    if args.v4:
        # P(species | cell), month-agnostic. This is the v2 quantity, rebuilt
        # from the same filtered table so the two slices cannot disagree about
        # which observations exist.
        con.execute("CREATE TEMP TABLE pooled_occ AS SELECT row, col, idx, "
                    "sum(n) n FROM occ GROUP BY 1,2,3")
        con.execute("CREATE TEMP TABLE pooled_tot AS SELECT row, col, sum(n) t "
                    "FROM pooled_occ GROUP BY 1,2")
        pooled = con.execute(
            "SELECT p.row, p.col, p.idx, p.n, t.t FROM pooled_occ p "
            "JOIN pooled_tot t ON p.row=t.row AND p.col=t.col "
            "ORDER BY p.row, p.col, p.idx").fetchall()
        log(str(len(pooled)) + " (species,cell) pooled pairs")

    # Build every slice into a dict keyed the same way the client searches, so
    # monthly and pooled runs cannot end up in different orders.
    slices = {}
    totals = {}
    for rw, cl, mo, idx, n, t in rows:
        cell = rw * GRID_COLS + cl
        key = (cell << MONTH_BITS) | (int(mo) - 1)
        s = slices.get(key)
        if s is None:
            s = []
            slices[key] = s
            totals[key] = int(t)
        s.append((idx, quant(n, t)))
    for rw, cl, idx, n, t in pooled:
        cell = rw * GRID_COLS + cl
        key = (cell << MONTH_BITS) | POOLED_MONTH_CODE
        s = slices.get(key)
        if s is None:
            s = []
            slices[key] = s
            totals[key] = int(t)
        s.append((idx, quant(n, t)))

    payload = bytearray()
    index = []
    order = sorted(slices.keys())
    for key in order:
        index.append((key, len(payload)))
        prev_idx = 0
        for idx, q in slices[key]:
            payload += varint(idx - prev_idx)
            prev_idx = idx
            payload.append(q)
    log(str(len(index)) + " slices, payload " + str(len(payload)) + " B")

    head = bytearray()
    head += MAGIC
    head += bytes([version, QBITS, MONTH_BITS, 0])
    head += tx_hash
    head += struct.pack("<I", len(index))
    for key, off in index:
        head += struct.pack("<II", key, off)
    head += struct.pack("<II", 0xFFFFFFFF, len(payload))
    if args.v4:
        # Parallel to the index, same order, one uint32 per entry. No key: the
        # client already knows the array position from its binary search.
        for key, _off in index:
            head += struct.pack("<I", totals[key])

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

    meta = {"magic": "WDOP", "version": version, "qbits": QBITS,
            "month_bits": MONTH_BITS, "scale": SCALE, "grid_cols": GRID_COLS,
            "taxonomy_sha256_8": tx_hash.hex(),
            "n_slices": len(index), "n_triples": len(rows),
            "n_pooled_pairs": len(pooled),
            "pooled_month_code": POOLED_MONTH_CODE if args.v4 else None,
            "intended_client_k": args.k if args.v4 else None,
            "min_count": args.min_count,
            "raw_bytes": len(blob), "gzip_bytes": len(gz),
            "content_hash": digest}
    json.dump(meta, open(out + ".meta.json", "w"), indent=2)
    log("wrote " + out)
    log("content hash: " + digest)
    print("=== BLOB v" + str(version) + " BUILD DONE ===")


if __name__ == "__main__":
    main()
