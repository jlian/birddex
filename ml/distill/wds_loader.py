"""WebDataset loader for the bird distillation corpus.

Reads the `.tar` shards produced by `pack_webdataset.py` (each sample:
`<key>.jpg` raw bytes + `<key>.emb` 768-d fp16 teacher embedding + `<key>.cls`
inat_taxon_id) and yields the SAME `(images, teacher_embeddings)` float32
batches that `BirdDistillDataset` + `collate` produce, so the training loop is
unchanged.

Why: the hand-rolled Dataset opens ~2.6M individual small files at random,
which is the prime suspect for the ~314 img/s ceiling. WebDataset streams
shards sequentially (NAS/HDD friendly) and is what open_clip's own training
path uses.

Note on shuffling: WebDataset shuffles at two levels -- shard order (across
epochs) and a within-shard sample buffer. That is NOT a global shuffle. Since
`pack_webdataset.py` writes rows ordered by taxon, a small buffer would give
taxon-correlated batches, so keep `--wds-shuffle` large (default 10000).
"""
import glob
import hashlib
import io
import os

import numpy as np
import torch
import webdataset as wds
from PIL import Image

EMB_DIM = 768


class MultiViewTargets:
    """photo_id -> [view0..viewN-1] teacher embeddings from a --views N cache.

    The shards carry ONE `.emb` per sample: the center-crop target. That is
    correct for `--aug none` / `--aug light`, but it is exactly what blocks TRUE
    strong aug -- an 8%-scale crop against a whole-image target is a wrong label,
    not harder data. With a multi-view cache we can hand the student the target
    matching the crop it actually sees.

    Usage: the loader picks a random view per sample per epoch and applies the
    SAME view's augmentation, so image and target stay paired.
    """

    def __init__(self, emb_dir):
        shards = sorted(glob.glob(os.path.join(emb_dir, "shard_*.npz")))
        if not shards:
            raise SystemExit(f"no shard_*.npz in {emb_dir}")
        by_pid = {}
        n_views = 0
        for sp in shards:
            with np.load(sp) as d:
                if "views" not in d:
                    raise SystemExit(
                        f"{sp} has no 'views' array -- that is a SINGLE-view cache. "
                        "Point --mv-embeddings at a --views N>1 precompute.")
                for pid, v, e in zip(d["photo_ids"], d["views"], d["embeddings"]):
                    by_pid.setdefault(int(pid), {})[int(v)] = e
                    n_views = max(n_views, int(v) + 1)
        # pack to a dense [n_views, 768] array per photo; drop incomplete ones
        self.table = {}
        dropped = 0
        for pid, vs in by_pid.items():
            if len(vs) != n_views:
                dropped += 1
                continue
            self.table[pid] = np.stack([vs[i] for i in range(n_views)])
        self.n_views = n_views
        print(f"[mv] {len(self.table):,} photos x {n_views} views "
              f"({dropped:,} dropped for incomplete view sets)", flush=True)

    def get(self, pid, view):
        row = self.table.get(int(pid))
        if row is None:
            return None
        return row[view % self.n_views]


def _in_val(key, val_frac, seed=42):
    """Deterministic per-sample train/val assignment.

    Hash the sample key (photo_id) so the split is stable across runs, workers
    and epochs without needing any state, and identical for train and val
    loaders (one takes the complement of the other).

    WHY NOT hold out a whole shard: `pack_webdataset.py` writes rows ordered by
    taxon, so any single shard covers only a handful of species (measured: the
    last pilot shard had 15 of 500). Validating on that is not comparable to the
    original random 2% split and would silently rank sweep runs on ~3% of the
    species. Hashing spreads val evenly across every shard and species.
    """
    h = hashlib.blake2b(f"{seed}:{key}".encode(), digest_size=8).digest()
    return (int.from_bytes(h, "big") % 1_000_000) < int(val_frac * 1_000_000)


def _decode(sample, preprocess, mv=None, view_tf=None, rng=None):
    """tar member dict -> (image_tensor, teacher_embedding).

    Single-view (mv=None): use the shard's baked-in center-crop `.emb`.

    Multi-view (mv set): pick a random view v, apply THAT view's transform to the
    image, and use the teacher embedding cached for the SAME v. Keeping the pair
    consistent is the entire point -- it is what makes aggressive crops a valid
    training signal instead of a mislabeled one. View 0 is the center crop, so
    v=0 degenerates to the single-view behaviour.
    """
    try:
        img = Image.open(io.BytesIO(sample["jpg"])).convert("RGB")
    except Exception:
        return None

    if mv is not None:
        try:
            pid = int(sample["__key__"])
        except (ValueError, KeyError):
            return None
        v = int(rng.integers(mv.n_views)) if rng is not None else 0
        emb = mv.get(pid, v)
        if emb is None:
            return None          # photo missing from the multi-view cache
        try:
            x = (preprocess(img) if v == 0 else view_tf(img))
        except Exception:
            return None
        return x, torch.from_numpy(np.asarray(emb, dtype=np.float32))

    try:
        x = preprocess(img)
    except Exception:
        return None
    emb = np.frombuffer(sample["emb"], dtype=np.float16)
    if emb.shape != (EMB_DIM,):
        return None
    return x, torch.from_numpy(emb.astype(np.float32))


def make_wds_loader(urls, preprocess, batch_size, workers,
                    shuffle=10000, is_train=True, epoch_samples=None,
                    val_frac=0.02, split_seed=42,
                    mv_targets=None, view_transform=None):
    """Build a DataLoader over WebDataset shards.

    Yields `(images, teacher_embeddings)` as stacked float32 tensors, i.e. the
    same contract as `BirdDistillDataset` + `collate`, so the training loop is
    unchanged. (webdataset's `.batched()` does the stacking itself -- no extra
    collate_fn is needed.)

    Train and val read the SAME shard list and are separated by a deterministic
    hash of the sample key (see `_in_val`), giving a stratified ~val_frac split
    that covers every species -- unlike holding out a taxon-ordered shard.

    urls: shard path list or glob/brace pattern.
    epoch_samples: define an epoch length (with_epoch) so the training loop's
          step math stays sane for an IterableDataset.
    """
    ds = wds.WebDataset(
        urls,
        # shardshuffle wants a positive int (buffer of shards) or 0/False
        shardshuffle=100 if is_train else False,
        handler=wds.ignore_and_continue,
        empty_check=False,
    )

    if val_frac and val_frac > 0:
        want_val = not is_train
        ds = ds.select(
            lambda s: _in_val(s["__key__"], val_frac, split_seed) == want_val
        )

    if is_train and shuffle:
        ds = ds.shuffle(shuffle)

    # validation always uses the deterministic center crop + its view-0 target,
    # so val_cos stays comparable across every run regardless of aug settings
    _mv = mv_targets if is_train else None
    _rng = np.random.default_rng(split_seed) if (is_train and mv_targets) else None
    ds = ds.map(lambda s: _decode(s, preprocess, _mv, view_transform, _rng),
                handler=wds.ignore_and_continue)
    # drop samples that failed to decode
    ds = ds.select(lambda x: x is not None)
    ds = ds.batched(batch_size, partial=not is_train)

    if epoch_samples:
        # NOTE: with_epoch() is applied AFTER .batched(), so each item is a BATCH,
        # hence nbatches= (passing a batch count as nsamples silently fails to cap
        # the epoch). ALSO: each DataLoader worker runs its own copy of the
        # pipeline and yields nbatches, so divide by the worker count or the loop
        # overruns steps/epoch by exactly `workers`x.
        total_batches = max(1, epoch_samples // max(1, batch_size))
        per_worker = max(1, total_batches // max(1, workers))
        ds = ds.with_epoch(nbatches=per_worker)

    loader = wds.WebLoader(
        ds,
        batch_size=None,
        num_workers=workers,
        pin_memory=True,
        persistent_workers=workers > 0,
    )
    return loader

