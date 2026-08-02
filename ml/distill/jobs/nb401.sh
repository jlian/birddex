#!/bin/bash
# Teacher experiment on the NABirds-ALIGNED 401-species pilot.
#
# WHY THIS RE-RUN: the previous teacher comparison (exp3 vs runA) was measured
# on a pilot whose species overlapped NABirds on SEVEN species / 282 images,
# so it settled nothing. wds-nabirds401 fixes that: 401 species, 184,949
# records, and the NABirds eval becomes 24,633 images over 401 species.
#
# ONLY the teacher varies between the two runs. Recipe is RUN B (0.2 basis),
# which the LR sweep confirmed is at the floor (7e-5 -> 0.9560, 5e-5 -> 0.9563,
# i.e. indistinguishable, and everything above 1e-4 collapses).
#
#   TEACH-W = WingCLIP-0.1 targets  (--sv-embeddings, needs the re-embed below)
#   TEACH-B = BioCLIP-2 targets     (omit --sv-embeddings, baked into shards)
cd /home/jlian/wingdex/ml/distill || exit 1
V=./.venv/bin/python
W='/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar'
SV=embeddings_wingclip_nb401
T39='timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m'
N=185000

# Wait for the LR sweep to release the GPU. Marker-file based, NOT pgrep:
# pattern-matching a process name that also appears in this script own command
# line makes the loop match itself and never exit (cost ~40 min on 2026-07-31).
echo "[$(date +%H:%M:%S)] waiting for /tmp/lr02sweep.done ..."
while [ ! -f /tmp/lr02sweep.done ]; do sleep 60; done
echo "[$(date +%H:%M:%S)] GPU free"

# ---- step 1: WingCLIP targets for the new shards (~21 min at ~148 emb/s) ----
if [ ! -f /tmp/nb401_embed.done ]; then
  echo ""
  echo "=== RE-EMBED WingCLIP-0.1 targets for wds-nabirds401 ==="
  $V -u precompute_embeddings.py --manifest train_manifest.parquet \
    --wds "$W" --out "$SV" --batch 256 --shard-size 50000 --fp16 \
    --model runs/ft_clean_01/wise_a0.90.pt 2>&1 \
    | grep -viE "hf_hub|unauthenticated"
  touch /tmp/nb401_embed.done
fi

# ---- step 2: the two runs ----
echo ""
echo "=== TEACH-W: WingCLIP-0.1 teacher (0.2 recipe, lr 7e-5) ==="
$V -u train_student.py --wds "$W" --wds-epoch-samples $N --sv-embeddings $SV \
  --arch "$T39" --pretrained pretrained --out runs/nb401_teach_wingclip \
  --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
  --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
  --min-lr 0.0 --patience 3 --lr 7e-5 2>&1 | grep -viE "hf_hub|unauthenticated"

echo ""
echo "=== TEACH-B: BioCLIP-2 teacher (0.2 recipe, lr 7e-5) ==="
$V -u train_student.py --wds "$W" --wds-epoch-samples $N \
  --arch "$T39" --pretrained pretrained --out runs/nb401_teach_bioclip \
  --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
  --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
  --min-lr 0.0 --patience 3 --lr 7e-5 2>&1 | grep -viE "hf_hub|unauthenticated"

# ---- step 3: the eval that actually decides it ----
# --pilot-species 0 scores ALL mapped NABirds species. That is correct HERE and
# only here: the students trained the 401 NABirds species, so there is no
# untrained-species penalty to confound it. 24,633 images instead of 282.
echo ""
echo "=== NABIRDS EVAL (401 species, full test split) ==="
for R in nb401_teach_wingclip nb401_teach_bioclip; do
  echo ""
  echo "--- $R ---"
  $V eval_nabirds.py --checkpoint runs/$R/best.pt \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --pilot-species 0 --batch 64 --out runs/nbeval_$R.json 2>&1 \
    | grep -viE "hf_hub|unauthenticated|huggingface_hub"
done

echo ""
echo "=== NB401 TEACHER EXPERIMENT DONE ==="
touch /tmp/nb401.done
