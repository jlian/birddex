"""Lay out heldout-orig to match what emit_calib_candidates.py expects.

The emitter builds paths as <corpus>/corpus/<taxon_id>/<photo_id>.<ext>. The
downloader wrote a flat directory. Symlink rather than copy: the originals are
2.1 GB and duplicating them buys nothing.

Doing it this way means the EXISTING emitter runs unmodified against the
high-res images, which is the whole point of reusing it.
"""
import json, os, sys
import pandas as pd

ML = "/home/jlian/wingdex/ml"
SRC = os.path.join(ML, "heldout-orig")
DST = os.path.join(ML, "heldout-orig-corpus", "corpus")

man = pd.read_parquet(os.path.join(ML, "distill/calib_untouched.parquet"))
by_id = {int(r.photo_id): (int(r.inat_taxon_id), r.extension) for r in man.itertuples()}

os.makedirs(DST, exist_ok=True)
linked = 0
missing = 0
for f in os.listdir(SRC):
    pid_s, _, ext = f.rpartition(".")
    try:
        pid = int(pid_s)
    except ValueError:
        continue
    if pid not in by_id:
        missing += 1
        continue
    taxon, man_ext = by_id[pid]
    d = os.path.join(DST, str(taxon))
    os.makedirs(d, exist_ok=True)
    # Use the MANIFEST extension: the emitter builds the path from it, so a
    # mismatch here silently looks like a missing image.
    dest = os.path.join(d, str(pid) + "." + man_ext)
    if not os.path.exists(dest):
        os.symlink(os.path.join(SRC, f), dest)
    linked += 1

print("linked:  %d" % linked)
print("not in manifest: %d" % missing)
print("corpus root for --corpus: %s" % os.path.join(ML, "heldout-orig-corpus"))
