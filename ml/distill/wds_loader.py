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
import io

import numpy as np
import torch
import webdataset as wds
from PIL import Image

EMB_DIM = 768


def _decode(sample, preprocess):
    """tar member dict -> (image_tensor, teacher_embedding, ok_flag)."""
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
                    shuffle=10000, is_train=True, epoch_samples=None):
    """Build a DataLoader over WebDataset shards.

    Yields `(images, teacher_embeddings)` as stacked float32 tensors, i.e. the
    same contract as `BirdDistillDataset` + `collate`, so the training loop is
    unchanged. (webdataset's `.batched()` does the stacking itself -- no extra
    collate_fn is needed.)

    urls: brace-expanded shard pattern(s), e.g.
          "/mnt/nas/WingDex-Distill/wds/shard-{00000..00249}.tar"
    epoch_samples: if set, define an epoch length (with_epoch) so the training
          loop's step math stays sane for an IterableDataset.
    """
    ds = wds.WebDataset(
        urls,
        # shardshuffle wants a positive int (buffer of shards) or 0/False
        shardshuffle=100 if is_train else False,
        handler=wds.ignore_and_continue,
        empty_check=False,
    )
    if is_train and shuffle:
        ds = ds.shuffle(shuffle)

    ds = ds.map(lambda s: _decode(s, preprocess), handler=wds.ignore_and_continue)
    # drop samples that failed to decode
    ds = ds.select(lambda x: x is not None)
    ds = ds.batched(batch_size, partial=not is_train)

    if epoch_samples:
        ds = ds.with_epoch(epoch_samples // max(1, batch_size))

    loader = wds.WebLoader(
        ds,
        batch_size=None,
        num_workers=workers,
        pin_memory=True,
        persistent_workers=workers > 0,
    )
    return loader

