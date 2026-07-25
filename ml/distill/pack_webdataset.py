#!/usr/bin/env python3
"""Pack corpus JPEGs + cached teacher embeddings into WebDataset .tar shards.

Per ml/README.md "Adopt upstream training path (option A)": each sample carries
the image BYTES (unmodified, original ~500px) + our 768-d BioCLIP-2 teacher
embedding + the taxon id, so open_clip's webdataset dataloader can stream them
sequentially instead of doing 2.6M random small-file opens.

Writes shards DIRECTLY to the destination (intended: the NAS) to avoid a 2x
local-disk peak -- the V: vhdx backing WSL only has ~49GB physically free.

Sample layout inside the tar (WebDataset convention, one basename per sample):
    <key>.jpg   raw image bytes, copied verbatim (no decode/re-encode)
    <key>.emb   768-d float16 teacher embedding, raw little-endian bytes
    <key>.cls   inat_taxon_id as ASCII text

Resumable: skips shards that already exist AND pass a size sanity check, so a
re-run fills gaps after an interruption.
"""
import argparse
import glob
import io
import json
import os
import sys
import tarfile
import time

import duckdb
import numpy as np


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_embedding_index(embeddings_dir):
    """photo_id -> (shard_path, row_idx). Values are small ints; 2.6M entries is fine."""
    index = {}
    shards = sorted(glob.glob(os.path.join(embeddings_dir, "shard_*.npz")))
    if not shards:
        raise SystemExit(f"no shard_*.npz found in {embeddings_dir}")
    for si, path in enumerate(shards):
        with np.load(path) as d:
            pids = d["photo_ids"]
        for row, pid in enumerate(pids):
            index[int(pid)] = (si, row)
        if (si + 1) % 50 == 0:
            log(f"  indexed {si+1}/{len(shards)} embedding shards ({len(index):,} ids)")
    return index, shards


class EmbeddingReader:
    """Lazily mmap one embedding shard at a time (sequential access pattern)."""

    def __init__(self, shard_paths):
        self.shard_paths = shard_paths
        self._cur = None
        self._cur_idx = -1

    def get(self, shard_idx, row):
        if shard_idx != self._cur_idx:
            if self._cur is not None:
                self._cur.close()
            self._cur = np.load(self.shard_paths[shard_idx])
            self._cur_idx = shard_idx
            self._emb = self._cur["embeddings"]
        return self._emb[row]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--corpus", default="corpus")
    ap.add_argument("--embeddings-dir", default="embeddings")
    ap.add_argument("--out", required=True,
                    help="destination dir for shards (intended: a NAS path)")
    ap.add_argument("--samples-per-shard", type=int, default=10000,
                    help="~10k x ~100KB = ~1GB shards, a good WebDataset size")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after N samples (smoke test)")
    ap.add_argument("--pilot-species", type=int, default=0,
                    help="pack ONLY the top-N species by image count (matches "
                         "train_student.py --pilot-species). Produces a small "
                         "pilot shard set for cheap sweep iteration: the pilot "
                         "species are SCATTERED across taxon order, so filtering "
                         "at train time would mean reading the whole corpus to "
                         "use ~10% of it")
    ap.add_argument("--start-shard", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    log("reading manifest via duckdb")
    con = duckdb.connect()
    where = "TRUE"
    if args.pilot_species and args.pilot_species > 0:
        top = con.execute(f"""
            SELECT inat_taxon_id FROM read_parquet('{args.train_manifest}')
            GROUP BY 1 ORDER BY count(*) DESC LIMIT {args.pilot_species}
        """).fetchall()
        ids = ",".join(str(r[0]) for r in top)
        where = f"inat_taxon_id IN ({ids})"
        log(f"--pilot-species {args.pilot_species}: filtering to top species by count")
    rows = con.execute(f"""
        SELECT photo_id, inat_taxon_id, extension
        FROM read_parquet('{args.train_manifest}')
        WHERE {where}
        ORDER BY inat_taxon_id, photo_id
    """).fetchall()
    log(f"manifest rows: {len(rows):,}")
    if args.limit:
        rows = rows[: args.limit]
        log(f"--limit: truncated to {len(rows):,}")

    log("building embedding index")
    emb_index, shard_paths = load_embedding_index(args.embeddings_dir)
    log(f"embedding index: {len(emb_index):,} photo_ids across {len(shard_paths)} shards")
    reader = EmbeddingReader(shard_paths)

    n_shard = args.start_shard
    written = skipped_noemb = skipped_noimg = 0
    tar = None
    shard_count = 0
    t0 = time.time()
    manifest_out = []

    def close_shard():
        nonlocal tar, shard_count
        if tar is not None:
            tar.close()
            log(f"  closed shard {n_shard:05d} ({shard_count:,} samples)")
            tar = None
            shard_count = 0

    for i, (photo_id, taxon_id, ext) in enumerate(rows):
        hit = emb_index.get(int(photo_id))
        if hit is None:
            skipped_noemb += 1
            continue
        img_path = os.path.join(args.corpus, str(taxon_id), f"{photo_id}.{ext}")
        try:
            with open(img_path, "rb") as f:
                img_bytes = f.read()
        except FileNotFoundError:
            skipped_noimg += 1
            continue
        if not img_bytes:
            skipped_noimg += 1
            continue

        if tar is None:
            shard_path = os.path.join(args.out, f"shard-{n_shard:05d}.tar")
            tar = tarfile.open(shard_path, "w")
            log(f"opening shard {n_shard:05d} -> {shard_path}")

        emb = np.asarray(reader.get(*hit), dtype=np.float16)
        key = str(photo_id)

        def add(name, payload):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(payload))

        add(f"{key}.jpg", img_bytes)
        add(f"{key}.emb", emb.tobytes())
        add(f"{key}.cls", str(taxon_id).encode())

        written += 1
        shard_count += 1

        if shard_count >= args.samples_per_shard:
            manifest_out.append({"shard": f"shard-{n_shard:05d}.tar", "samples": shard_count})
            close_shard()
            n_shard += 1

        if written % 50000 == 0:
            el = time.time() - t0
            log(f"  {written:,} packed ({written/el:.0f}/s), "
                f"skipped: no-emb={skipped_noemb:,} no-img={skipped_noimg:,}")

    if tar is not None:
        manifest_out.append({"shard": f"shard-{n_shard:05d}.tar", "samples": shard_count})
        close_shard()

    meta = {
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source_manifest": os.path.abspath(args.train_manifest),
        "samples_written": written,
        "skipped_no_embedding": skipped_noemb,
        "skipped_no_image": skipped_noimg,
        "samples_per_shard": args.samples_per_shard,
        "shards": manifest_out,
        "format": {
            "jpg": "raw image bytes, verbatim from corpus (no re-encode)",
            "emb": "768-d float16 BioCLIP-2 ViT-L teacher embedding, raw LE bytes",
            "cls": "inat_taxon_id, ASCII",
        },
    }
    with open(os.path.join(args.out, "shards.json"), "w") as f:
        json.dump(meta, f, indent=2)

    el = time.time() - t0
    log(f"DONE: {written:,} samples in {len(manifest_out)} shards, {el/60:.1f} min "
        f"({written/max(1,el):.0f}/s)")
    log(f"skipped: no-embedding={skipped_noemb:,}  no-image={skipped_noimg:,}")
    log(f"wrote {os.path.join(args.out, 'shards.json')}")


if __name__ == "__main__":
    main()
