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
# headers or linking zlib. Raw is 23.0 MiB against 15.7 MiB gzipped, and the
# IPA is compressed for delivery anyway.
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

# Exactly one prior, matched by the content hash in its name. Two would mean an
# old blob was left behind and the wrong one could be picked up silently.
shopt -s nullglob
PRIORS=("$REPO_ROOT"/public/priors/occurrence.*.bin.gz)
shopt -u nullglob
if [[ ${#PRIORS[@]} -ne 1 ]]; then
  echo "error: expected exactly 1 occurrence prior, found ${#PRIORS[@]}" >&2
  printf '  %s\n' "${PRIORS[@]}" >&2
  exit 1
fi
PRIOR="${PRIORS[0]}"

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

# The taxonomy the prior is keyed by must be the one the app bundles, or every
# species index is silently wrong. The blob carries a hash of it and the parser
# throws on mismatch, but failing here is a much better error.
if ! cmp -s "$REPO_ROOT/src/lib/taxonomy.json" "WingDex/Resources/taxonomy.json"; then
  echo "error: ios taxonomy.json differs from src/lib/taxonomy.json" >&2
  exit 1
fi
