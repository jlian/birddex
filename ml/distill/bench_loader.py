#!/usr/bin/env python3
"""What is the ACTUAL throughput with DataLoader workers AND fp16 together?

The 655 img/s fp16 figure was measured on pre-loaded GPU tensors, and the
224 img/s decode figure was measured single-threaded with no GPU running. That
tells us nothing about the combination, which is what we would actually ship.
This measures the real end-to-end pipeline on real shards.
"""
import argparse
import io
import sys
import tarfile
import time

import torch
from PIL import Image
from torch.utils.data import DataLoader, IterableDataset


class ShardStream(IterableDataset):
    def __init__(self, shards, preprocess, limit):
        self.shards = shards
        self.pp = preprocess
        self.limit = limit

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        nw = info.num_workers if info else 1
        n = 0
        # shard-level sharding across workers: no two workers read the same tar
        for si, sp in enumerate(self.shards):
            if si % nw != wid:
                continue
            with tarfile.open(sp) as t:
                for m in t:
                    if not m.name.endswith(".jpg"):
                        continue
                    b = t.extractfile(m).read()
                    try:
                        img = Image.open(io.BytesIO(b)).convert("RGB")
                    except Exception:
                        continue
                    yield self.pp(img)
                    n += 1
                    if self.limit and n >= self.limit // nw:
                        return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--shards", required=True)
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=256)
    args = ap.parse_args()

    import glob
    shards = sorted(glob.glob(args.shards))
    print("shards:", len(shards))

    sys.path.insert(0, ".")
    from train_student import Student
    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})

    def build(half):
        s = Student(ca.get("arch", "ViT-B-16"),
                    ca.get("pretrained", "laion2b_s34b_b88k"))
        s.load_state_dict(ck["model"])
        s = s.cuda().eval()
        return s

    st = build(False)
    pp = st.preprocess

    print()
    print("workers  precision   img/s")
    print("-" * 34)
    for nw in [0, 4, 8, 12]:
        for prec in ["fp32", "fp16"]:
            ds = ShardStream(shards, pp, args.n)
            dl = DataLoader(ds, batch_size=args.batch, num_workers=nw,
                            pin_memory=True,
                            prefetch_factor=(4 if nw else None),
                            persistent_workers=False)
            n = 0
            torch.cuda.synchronize()
            t0 = time.time()
            with torch.no_grad():
                for xb in dl:
                    xb = xb.cuda(non_blocking=True)
                    if prec == "fp16":
                        with torch.autocast("cuda", dtype=torch.float16):
                            e = st(xb)
                    else:
                        e = st(xb)
                    n += xb.shape[0]
            torch.cuda.synchronize()
            dt = time.time() - t0
            print("{:>4}     {:6s}  {:8.1f}".format(nw, prec, n / dt))
            del dl, ds
    print()
    print("current precompute_embeddings.py = 0 workers, fp32")
    print("=== LOADER BENCH DONE ===")


if __name__ == "__main__":
    main()
