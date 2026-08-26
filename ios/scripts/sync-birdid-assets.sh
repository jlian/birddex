#!/bin/bash
# Derive the bird-ID assets that iOS shares with the web build.
#
# Two of the three shipped assets are not iOS-specific:
#   text_classifier_int8.bin   byte-identical to the web copy
#   occurrence.bin             the web .gz, decompressed
#
# Copying them here rather than committing a second copy keeps public/ the
# single source of truth, so regenerating the prior cannot leave iOS shipping
# stale bytes against a taxonomy hash that no longer matches.
#
# The Core ML model is NOT derived: it comes from a checkpoint that only exists
# on Hugging Face and needs a torch/coremltools environment, so it is committed
# under ios/WingDex/ML. See ml/coreml/convert_coreml.py.
#
# iOS reads the prior UNCOMPRESSED. Apple's Compression framework does raw
# deflate, not gzip, so decoding the .gz on device would mean hand-parsing gzip
# headers or linking zlib. Raw is 32.97 MiB against 21.58 MiB gzipped, and
# the IPA is compressed for delivery anyway.
#
# Both figures are the SHIPPED v4 blob, measured on
# public/priors/occurrence.4f5c1a15.bin.gz: 22,623,826 bytes on disk,
# 34,576,516 decompressed. The RAW number was left at v3's 23.0 MiB when the
# gzipped one was updated to v4, which understated the bundled iOS asset by
# about 10 MiB. v3 for reference: 24,123,497 raw / 16,478,112 gzipped.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(cd .. && pwd)"
DEST="WingDex/Resources/BirdID"

mkdir -p "$DEST"

CLASSIFIER="$REPO_ROOT/public/models/text_classifier_int8.bin"
if [[ ! -f "$CLASSIFIER" ]]; then
  echo "error: missing $CLASSIFIER" >&2
  exit 1
fi

# The prior the app SHIPS, named by the content hash of its bytes.
#
# This used to assert exactly one occurrence.*.bin.gz existed, on the reasoning
# that a second file meant a stale blob was left behind and the wrong one could
# be picked up silently. That reasoning is still right, but the glob was the
# wrong instrument: public/priors now legitimately holds TWO blobs, the shipped
# v4 and the v3 that src/__tests__/occurrence-v3-compat.test.ts reads to prove
# the v4 reader still parses the format still cached in the wild. The glob made
# an Xcode build fail before a single v4 test ran.
#
# Selecting the EXACT shipped filename keeps the original guard and makes it
# stronger: an extra blob is now simply ignored, and a missing or renamed
# shipped blob is a hard error instead of a silent substitution. The name is
# read from MODEL_ASSET_URLS in the web adapter rather than repeated here, so
# regenerating the prior updates one place and iOS follows.
ADAPTER="$REPO_ROOT/src/lib/bird-id-local-adapter.ts"
if [[ ! -f "$ADAPTER" ]]; then
  echo "error: missing $ADAPTER" >&2
  echo "  it is declared in ios/project.yml inputFiles; if that entry is" >&2
  echo "  gone, script sandboxing denies the read and this looks identical" >&2
  exit 1
fi
# grep exits 1 on no match, and under `set -e` that would kill the script at
# this assignment, making the empty-match diagnostic below unreachable. The
# `|| true` keeps the failure local so the message actually fires.
PRIOR_NAME="$(grep -o '/priors/occurrence\.[0-9a-f]*\.bin\.gz' "$ADAPTER" | head -1 || true)"
PRIOR_NAME="${PRIOR_NAME#/priors/}"
if [[ -z "$PRIOR_NAME" ]]; then
  echo "error: no /priors/occurrence.<hash>.bin.gz in $ADAPTER" >&2
  echo "  the shipped prior is named by MODEL_ASSET_URLS; iOS reads it there" >&2
  exit 1
fi
PRIOR="$REPO_ROOT/public/priors/$PRIOR_NAME"
if [[ ! -f "$PRIOR" ]]; then
  echo "error: missing shipped prior $PRIOR" >&2
  echo "  MODEL_ASSET_URLS names $PRIOR_NAME but public/priors has:" >&2
  ls -1 "$REPO_ROOT/public/priors" >&2
  exit 1
fi

# The rarity asset, read the same way from the module that owns its format.
# It is NOT in MODEL_ASSET_URLS: it ships outside the gated model download
# because it renders on list screens, not only during identification.
RARITY_SRC="$REPO_ROOT/src/lib/rarity.ts"
if [[ ! -f "$RARITY_SRC" ]]; then
  echo "error: missing $RARITY_SRC" >&2
  echo "  it is declared in ios/project.yml inputFiles; if that entry is" >&2
  echo "  gone, script sandboxing denies the read and this looks identical" >&2
  exit 1
fi
RARITY_NAME="$(grep -o '/priors/rarity\.[0-9a-f]*\.bin\.gz' "$RARITY_SRC" | head -1 || true)"
RARITY_NAME="${RARITY_NAME#/priors/}"
if [[ -z "$RARITY_NAME" ]]; then
  echo "error: no /priors/rarity.<hash>.bin.gz in $RARITY_SRC" >&2
  echo "  RARITY_ASSET_URL names the shipped asset; iOS reads it there" >&2
  exit 1
fi
RARITY="$REPO_ROOT/public/priors/$RARITY_NAME"
if [[ ! -f "$RARITY" ]]; then
  echo "error: missing shipped rarity asset $RARITY" >&2
  echo "  RARITY_ASSET_URL names $RARITY_NAME but public/priors has:" >&2
  ls -1 "$REPO_ROOT/public/priors" >&2
  exit 1
fi

# Rewrite only when the bytes actually differ. mtime is not enough: a preserved
# or restored workspace can leave a stale generated file with a newer timestamp
# than freshly checked-out sources, silently bundling old classifier/prior data
# against a new Core ML model. Content comparison is the same guard used for
# taxonomy.json below.
if [[ ! -f "$DEST/text_classifier_int8.bin" ]] || ! cmp -s "$CLASSIFIER" "$DEST/text_classifier_int8.bin"; then
  cp "$CLASSIFIER" "$DEST/text_classifier_int8.bin"
  echo "copied text_classifier_int8.bin"
fi

if [[ ! -f "$DEST/occurrence.bin" ]] || ! gunzip -c "$PRIOR" | cmp -s - "$DEST/occurrence.bin"; then
  gunzip -c "$PRIOR" > "$DEST/occurrence.bin"
  echo "decompressed $(basename "$PRIOR") -> occurrence.bin"
fi

if [[ ! -f "$DEST/rarity.bin" ]] || ! gunzip -c "$RARITY" | cmp -s - "$DEST/rarity.bin"; then
  gunzip -c "$RARITY" > "$DEST/rarity.bin"
  echo "decompressed $(basename "$RARITY") -> rarity.bin"
fi

# The taxonomy the prior is keyed by must be the one the app bundles, or every
# species index is silently wrong. The blob carries a hash of it and the parser
# throws on mismatch, but failing here is a much better error.
if ! cmp -s "$REPO_ROOT/src/lib/taxonomy.json" "WingDex/Resources/taxonomy.json"; then
  echo "error: ios taxonomy.json differs from src/lib/taxonomy.json" >&2
  exit 1
fi
