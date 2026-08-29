# Single source for the osmium tag filters both builds share.
#
# The forward-search export and the reverse archive MUST select the same
# features: that shared inclusion contract is what lets the two systems agree
# about a place. Keeping a second copy of the filter literal in each script
# broke that silently, because the extracts are cached under a hash OF the
# filter, so changing one script left the other finding an older cache and
# using a different corpus with no error anywhere.
#
# Override by exporting FILTER or ADMIN_FILTER before sourcing this file.

# Named features a birder might search for or stand inside.
#
# `wr/` (ways and relations), not `nwr/`: nodes are deliberately excluded, see
# commit 4092a1c.
FILTER="${FILTER:-wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural wr/place wr/tourism}"

# Administrative boundaries, for ISO codes and locality names.
ADMIN_FILTER="${ADMIN_FILTER:-r/boundary=administrative}"

# ADMIN_LEVELS is deliberately NOT set here, because the two builds legitimately
# differ: the reverse archive takes levels 2-4, which is where ISO 3166 codes
# live, while forward search also takes level 6 for county NAMES. Defining it in
# this shared file would leak the search setting into the reverse archive,
# because a `${VAR:-default}` further down cannot override a value already set.
