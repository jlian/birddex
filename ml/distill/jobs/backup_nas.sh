#!/bin/bash
# Back up the irreplaceable WingDex ML artifacts to the NAS.
#
# Last backup was 2026-07-24; nine days of work since then, on a machine that
# hard-hung twice in 18 hours. Priority is things that are EXPENSIVE OR
# IMPOSSIBLE to regenerate, not things that are merely large.
#
# SKIPPED ON PURPOSE:
#   runs/*/  (46G) - only best.pt/last.pt matter and only for live work; every
#                    other epoch artifact is reproducible from the shards.
#   nabirds/ (9.5G) - public dataset, re-downloadable.
#   wds shards      - already ON the NAS, that IS the primary copy.
set -u
SRC=/home/jlian/wingdex/ml/distill
DST=/mnt/nas/WingDex-Distill-Backup/$(date +%Y%m%d)
LOG=/home/jlian/backup-$(date +%Y%m%d-%H%M%S).log

exec > >(tee -a "$LOG") 2>&1
echo "[$(date +%H:%M:%S)] backup -> $DST"
mkdir -p "$DST" || exit 1

copy () {
  local what="$1"
  if [ ! -e "$SRC/$what" ]; then
    echo "  SKIP (missing): $what"
    return
  fi
  echo "[$(date +%H:%M:%S)] copying $what ..."
  rsync -a --info=progress2 --no-inc-recursive "$SRC/$what" "$DST/" 2>&1 | tail -2
}

# --- teacher embeddings: ~56 GPU-hours to regenerate. The single most
#     expensive artifact we own. ---
copy embeddings
copy embeddings_wingclip_pilot500
copy embeddings_mv5_pilot500

# --- manifests + taxonomy + occurrence: derived from API pulls that may not
#     be reproducible (iNat/GBIF snapshots move) ---
for f in manifest.parquet train_manifest.parquet taxonomy.json \
         occurrence_cells.parquet occurrence_thinned.parquet \
         occurrence_pre2024.parquet occurrence_gbif.parquet \
         occurrence_totals.parquet occurrence_gbif_totals.parquet \
         occurrence_pre2024_totals.parquet occurrence_thinned_totals.parquet \
         groundtruth_heldout.parquet groundtruth_heldout_distilled.parquet \
         calib_untouched.parquet calib_cands_01_a090.parquet \
         download_manifest.jsonl.gz inat_resolved.jsonl \
         attributions.csv ATTRIBUTIONS.md nabirds_to_taxo.json \
         nabirds_teacher_cache.npz obs_split_pilot500.json \
         nabirds_pilot_species.json pilot500_classes.json \
         pilot500_taxo_idx.json experiments.json \
         calibration_01_a090.json calibration_bayes_01.json \
         calibration_occ_01.json target_taxa.csv; do
  copy "$f"
done

# --- the ship candidate + its eval results ---
echo "[$(date +%H:%M:%S)] copying ship-candidate checkpoints ..."
mkdir -p "$DST/runs_ship"
for r in ft_clean_01 full7555_vitb; do
  if [ -d "$SRC/runs/$r" ]; then
    mkdir -p "$DST/runs_ship/$r"
    rsync -a "$SRC/runs/$r"/*.pt "$SRC/runs/$r"/*.json "$DST/runs_ship/$r/" 2>/dev/null
    echo "  $r: $(ls -1 $DST/runs_ship/$r | wc -l) files"
  fi
done

# --- current pilot checkpoints (live work, cheap to include) ---
for r in tiny39_r01 tiny39_r02 tiny39_bioclip_teacher tiny39_r02_lr5e5 tiny39_r02_lr3e5; do
  if [ -d "$SRC/runs/$r" ]; then
    mkdir -p "$DST/runs_pilot/$r"
    rsync -a "$SRC/runs/$r/best.pt" "$DST/runs_pilot/$r/" 2>/dev/null
  fi
done
echo "  pilot checkpoints: $(du -sh $DST/runs_pilot 2>/dev/null | cut -f1)"

# --- eval results (small, and they are the evidence trail) ---
mkdir -p "$DST/eval_results"
rsync -a "$SRC/runs"/nbfix_*.json "$SRC/runs"/nabirds_*.json \
      "$SRC"/eval_*.json "$DST/eval_results/" 2>/dev/null
echo "  eval jsons: $(ls -1 $DST/eval_results 2>/dev/null | wc -l)"

echo ""
echo "[$(date +%H:%M:%S)] DONE. total:"
du -sh "$DST"
echo "log: $LOG"
touch /tmp/backup.done
