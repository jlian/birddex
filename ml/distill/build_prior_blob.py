#!/usr/bin/env python3
"""Build the SHIPPABLE occurrence prior: ONE binary blob, sliced client-side.

Decided 2026-07-31: worldwide, single file, whole-file gzip. No tiles, no
per-cell CDN objects, no deploy-time file-count ceiling, no boundary logic.
The client fetches once, caches immutably, decompresses into memory, and
binary-searches the index to slice one cell.

LAYOUT (little-endian throughout):
  magic      4B   "WDOP"
  version    1B   format version
  qbits      1B   quantisation bits for log-prob (5)
  reserved   2B
  tax_hash   8B   sha256(taxonomy.json)[:8] -- species are keyed by ROW
                  INDEX into taxonomy.json, so a reordered or extended
                  taxonomy would silently mis-key EVERY prior with no
                  error. The client MUST refuse a blob whose hash does
                  not match the taxonomy it is running against.
  n_cells    4B   uint32
  INDEX      n_cells * 8B, sorted ascending by cell_id:
               cell_id  4B uint32  (row * 1276 + col)
               offset   4B uint32  (byte offset into PAYLOAD)
  sentinel   8B   (0xFFFFFFFF, total_payload_len) so cell i length =
                  index[i+1].offset - index[i].offset with no special case
  PAYLOAD    concatenated per-cell records:
               varint(delta of sorted species index) + 1B quantised logprob

Species are keyed by 2-byte TAXONOMY INDEX (app_idx into taxonomy.json), not
the 8-byte eBird code -- measured 9.1 MiB vs 27.3 MiB raw.

Quantisation: 5 bits measured FREE (-0.03 pts) vs float32. Stored in one byte
for simplicity; the value is q = round(-log(p) * SCALE) clamped to [0, 31].
Client recovers log(p) = -q / SCALE.
"""
import argparse
import gzip
import json
import math
import struct
import time

import hashlib

import duckdb

MAGIC = b"WDOP"
VERSION = 2
QBITS = 5
QMAX = (1 << QBITS) - 1
SCALE = 2.5
GRID_COLS = 1276


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
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--taxonomy", required=True,
                    help="src/lib/taxonomy.json -- hashed into the header so a reordered taxonomy cannot silently mis-key every prior")
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

    con.execute("CREATE TEMP TABLE occ AS SELECT o.row, o.col, b.idx, o.n "
                "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ") o "
                "JOIN birds b ON o.taxon_id = b.tid WHERE o.n >= " +
                str(args.min_count))
    con.execute("CREATE TEMP TABLE tot AS SELECT row, col, sum(n) t "
                "FROM occ GROUP BY 1,2")
    rows = con.execute("SELECT o.row, o.col, o.idx, o.n, t.t FROM occ o "
                       "JOIN tot t ON o.row=t.row AND o.col=t.col "
                       "ORDER BY o.row, o.col, o.idx").fetchall()
    log(str(len(rows)) + " (species,cell) pairs after bird filter")

    payload = bytearray()
    index = []
    cur_key = None
    prev_idx = 0
    ncells = 0
    for rw, cl, idx, n, t in rows:
        key = rw * GRID_COLS + cl
        if key != cur_key:
            index.append((key, len(payload)))
            cur_key = key
            prev_idx = 0
            ncells += 1
        p = max(n / max(t, 1), 1e-9)
        q = int(max(0, min(QMAX, round(-math.log(p) * SCALE))))
        payload += varint(idx - prev_idx)
        prev_idx = idx
        payload.append(q)
    log(str(ncells) + " cells, payload " + str(len(payload)) + " B")

    # index must be sorted by cell_id for client binary search
    index.sort(key=lambda x: x[0])
    head = bytearray()
    head += MAGIC
    head += bytes([VERSION, QBITS, 0, 0])
    head += tx_hash                      # 8B taxonomy guard
    head += struct.pack("<I", len(index))
    for key, off in index:
        head += struct.pack("<II", key, off)
    head += struct.pack("<II", 0xFFFFFFFF, len(payload))

    blob = bytes(head) + bytes(payload)
    gz = gzip.compress(blob, 9)
    open(args.out, "wb").write(gz)
    open(args.out + ".raw", "wb").write(blob)
    log("raw  " + str(len(blob)) + " B (" + str(round(len(blob) / 1048576.0, 2)) + " MiB)")
    log("gzip " + str(len(gz)) + " B (" + str(round(len(gz) / 1048576.0, 2)) + " MiB)")
    log("wrote " + args.out)

    meta = {"magic": "WDOP", "version": VERSION, "qbits": QBITS,
            "scale": SCALE, "grid_cols": GRID_COLS,
            "taxonomy_sha256_8": tx_hash.hex(),
            "n_cells": len(index), "n_pairs": len(rows),
            "raw_bytes": len(blob), "gzip_bytes": len(gz)}
    json.dump(meta, open(args.out + ".meta.json", "w"), indent=2)
    print("=== BLOB BUILD DONE ===")


if __name__ == "__main__":
    main()
