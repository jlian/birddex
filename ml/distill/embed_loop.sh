#!/usr/bin/env bash
# Keep the teacher-embedding precompute continuously catching up with the pull.
# Each pass embeds whatever new on-disk images exist, exits, then we loop.
# Stops itself once the pull is done AND a pass embeds 0 new images (fully caught up).
set -u
cd "$HOME/spikes/bioclip-birdid/distill" || exit 1
VENV=../.venv/bin/python

while true; do
  before=$(ls embeddings/shard_*.npz 2>/dev/null | wc -l)
  $VENV precompute_embeddings.py --manifest manifest.parquet --corpus corpus \
      --out embeddings --batch 256 --shard-size 50000 >> precompute.log 2>&1
  after=$(ls embeddings/shard_*.npz 2>/dev/null | wc -l)
  pull_done=$(grep -c "^done:" pull_images.log 2>/dev/null || echo 0)
  if [ "$pull_done" -ge 1 ] && [ "$after" -eq "$before" ]; then
    echo "$(date -Is) embed_loop: pull done + no new embeddings, exiting" >> precompute.log
    break
  fi
  sleep 60
done
