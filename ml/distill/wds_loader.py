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
import hashlib
import io

import numpy as np
import torch
import webdataset as wds
from PIL import Image

EMB_DIM = 768


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


def _decode(sample, preprocess):
    """tar member dict -> (image_tensor, teacher_embedding)."""
    try:
        img = Image.open(io.BytesIO(sample["jpg"])).convert("RGB")
        x = preprocess(img)
    except Exception:
        return None
    emb = np.frombuffer(sample["emb"], dtype=np.float16)
    if emb.shape != (EMB_DIM,):
        return None
    t = torch.from_numpy(emb.astype(np.float32))
    return x, t


def make_wds_loader(urls, preprocess, batch_size, workers,
                    shuffle=10000, is_train=True, epoch_samples=None,
                    val_frac=0.02, split_seed=42):
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

    ds = ds.map(lambda s: _decode(s, preprocess), handler=wds.ignore_and_continue)
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

