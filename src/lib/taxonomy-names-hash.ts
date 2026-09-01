/**
 * sha256 of the eBird code, common name, and scientific name tuples, sorted
 * by code and truncated to 16 hex characters.
 *
 * WHY THIS EXISTS, SEPARATELY FROM TAXONOMY_SHA16
 *
 * TAXONOMY_SHA16 changes whenever taxonomy.json changes at all: a new species,
 * a reordering, a corrected thumbnail. Most taxonomy updates are harmless.
 *
 * This one changes only when a coded species is ADDED, REMOVED, or its common or
 * scientific name is RENAMED. It does not cover uncoded rows, ordering, images,
 * or other metadata. Names are the dangerous subset because a dex group is
 * currently keyed by the display name (see issue #306). If the server starts
 * storing a new common or scientific name while a shipped client still writes
 * the old one, the two spellings become two
 * separate dex entries, with `dex_meta` keyed by `(userId, speciesName)` on
 * both. Nothing errors; the life list silently gains a duplicate and the notes
 * on one spelling are invisible from the other.
 *
 * THE RULE THIS ENFORCES
 *
 * If this hash changes, run:
 *
 *     node scripts/diff-taxonomy-names.mjs origin/main
 *
 * The base ref is required, and it must be a revision from BEFORE the taxonomy
 * changed. The script refuses HEAD, any spelling of it, and any other revision
 * carrying the same taxonomy file, because comparing the taxonomy with itself
 * can never report a rename.
 *
 * It reports adds, removals, common-name renames, and scientific-name renames
 * separately. Adds and removals are safe to ship. A RENAME is not, until
 * observations are keyed by species code instead of by name. Ship the
 * code-keying migration first, or in the same release, and never ship a client
 * that writes the old spelling afterwards.
 *
 * Update this constant only after that check, in the same commit as the
 * taxonomy change, so review sees both together.
 */
export const TAXONOMY_NAMES_SHA16 = '686e64653d8ac478'
