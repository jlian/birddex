// GENERATED FILE. Do not edit by hand.
//
// Written by `scripts/osm-places/r2-upload.mjs` after an upload is verified,
// so the key the Worker reads is always the key that was actually published.
//
// This exists because the constant used to be updated by hand, and the caches
// in `osm-places.ts` are keyed on it. Forgetting the bump does not fail
// loudly: a warm isolate keeps serving cached header and directory bytes whose
// offsets describe the PREVIOUS archive, so every lookup in that isolate
// throws until it recycles, while cold isolates answer normally. Generating
// the value removes the chance to forget.
export const PLACES_KEY = 'places-20260828.pmtiles'
