"""Reduce Nominatim's 19M-row importance table to one score per Wikidata QID.

A QID appears once per language, so the rows must be collapsed. Nominatim's own
ranking takes the MAX across languages: a place with a big English article and a
stub in Latvian is important, and taking a mean would punish it for the stub.

Output is a compact TSV of `numeric_qid<TAB>quantised_score`, quantised to 0..255
because this is only ever a third tie-breaker in place-rank.ts. Full float
precision would cost 4x the bytes to decide ties that a byte already decides.
"""
import gzip, sys

src = sys.argv[1]
out = sys.argv[2]

best = {}
n = 0
skipped = 0
with gzip.open(src, "rt", encoding="utf-8", errors="replace") as fh:
    header = fh.readline().rstrip("\n").split("\t")
    qi = header.index("wikidata_id")
    ii = header.index("importance")
    for line in fh:
        n += 1
        parts = line.rstrip("\n").split("\t")
        if len(parts) <= max(qi, ii):
            skipped += 1
            continue
        q = parts[qi]
        if not q or not q.startswith("Q"):
            skipped += 1
            continue
        try:
            v = float(parts[ii])
        except ValueError:
            skipped += 1
            continue
        try:
            qn = int(q[1:])
        except ValueError:
            skipped += 1
            continue
        if v > best.get(qn, -1.0):
            best[qn] = v

with open(out, "w", encoding="ascii") as w:
    for qn in sorted(best):
        # Round-half-up into 0..255. Values are already 0..1.
        q8 = min(255, max(0, int(best[qn] * 255 + 0.5)))
        w.write(f"{qn}\t{q8}\n")

print(f"rows read      : {n:,}")
print(f"rows skipped   : {skipped:,}")
print(f"distinct QIDs  : {len(best):,}")
