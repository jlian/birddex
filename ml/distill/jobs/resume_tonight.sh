#!/bin/bash
# Resume the overnight queue after the 15:15-00:00 GPU break.
#
# lr 3e-5 was stopped mid-run and resumes from last.pt via --resume, which
# restores model+optimizer+scheduler+scaler+epoch so it continues the SAME LR
# trajectory rather than warm-restarting.
cd /home/jlian/wingdex/ml/distill || exit 1
V=./.venv/bin/python
W02='/mnt/nas/WingDex-Distill/wds-pilot500/shard-*.tar'
T39='timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m'

echo "[$(date +%H:%M:%S)] resuming after the evening break"

# ---- finish lr 3e-5 (confirmatory only; LR is already known to be at the
# floor: 7e-5 -> 0.9560, 5e-5 -> 0.9563) ----
if [ ! -f /tmp/lr02sweep.done ]; then
  echo ""
  echo "=== LR02 lr 3e-5 RESUMED (RUN B 0.2 recipe, lr swept) ==="
  $V -u train_student.py --wds "$W02" --wds-epoch-samples 244000 \
    --sv-embeddings embeddings_wingclip_pilot500 \
    --arch "$T39" --pretrained pretrained --out runs/tiny39_r02_lr3e5 \
    --resume runs/tiny39_r02_lr3e5/last.pt \
    --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 3e-5 2>&1 | grep -viE "hf_hub|unauthenticated"
  touch /tmp/lr02sweep.done
fi

# ---- hand off to the teacher experiment, which waits on that marker ----
echo ""
echo "[$(date +%H:%M:%S)] starting the nb401 teacher experiment"
exec /tmp/nb401.sh
