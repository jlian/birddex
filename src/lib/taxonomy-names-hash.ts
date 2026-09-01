/**
 * sha256 of sorted [eBird code, common name, scientific name] tuples,
 * truncated to 16 hex characters.
 *
 * Update only after running `node scripts/diff-taxonomy-names.mjs <base-ref>`.
 * The base must carry a different taxonomy blob so the comparison cannot
 * silently compare the taxonomy with itself.
 */
export const TAXONOMY_NAMES_SHA16 = '686e64653d8ac478'
