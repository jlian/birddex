/**
 * sha256 of the eBird code to common-name mapping, sorted by code, truncated
 * to 16 hex characters.
 *
 * WHY THIS EXISTS, SEPARATELY FROM TAXONOMY_SHA16
 *
 * TAXONOMY_SHA16 changes whenever taxonomy.json changes at all: a new species,
 * a reordering, a corrected thumbnail. Most taxonomy updates are harmless.
 *
 * This one changes only when a species is ADDED, REMOVED, or RENAMED. That is
 * the dangerous subset, because a dex group is currently keyed by the display
 * name (see issue #306). If the server starts calling a bird by a new name
 * while a shipped client still writes the old one, the two spellings become two
 * separate dex entries, with `dex_meta` keyed by `(userId, speciesName)` on
 * both. Nothing errors; the life list silently gains a duplicate and the notes
 * on one spelling are invisible from the other.
 *
 * THE RULE THIS ENFORCES
 *
 * If this hash changes, run:
 *
 *     node scripts/diff-taxonomy-names.mjs
 *
 * It reports adds, removals and renames separately. Adds and removals are safe
 * to ship. A RENAME is not, until observations are keyed by species code
 * instead of by name. Ship the code-keying migration first, or in the same
 * release, and never ship a client that writes the old spelling afterwards.
 *
 * Update this constant only after that check, in the same commit as the
 * taxonomy change, so review sees both together.
 */
export const TAXONOMY_NAMES_SHA16 = '1c876c0f88ef80e1'
