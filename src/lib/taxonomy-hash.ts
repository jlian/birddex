/**
 * sha256(taxonomy.json)[:8].
 *
 * Species are keyed by ROW INDEX into taxonomy.json in both the occurrence
 * prior and the rarity asset, so a reordered or extended taxonomy would
 * silently mis-key every value. Both formats carry this hash and refuse to
 * parse on a mismatch.
 *
 * Its own module so a page that only needs the 1.38 MiB rarity asset can check
 * the guard without importing bird-id-local-adapter and the ONNX runtime.
 */
export const TAXONOMY_SHA16 = "04951673b96b11bf"
