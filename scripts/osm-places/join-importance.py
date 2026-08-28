"""Replace each feature's `wikidata` QID with a quantised `importance` score.

Runs between `osmium export` and `tippecanoe`, so the join happens ONCE at build
time rather than per request at runtime.

Why replace rather than add: the QID is only ever a join key, and once the join
is done offline the key is dead weight. Measured over 3,551 real tiles, the QID
strings cost 130,277 bytes of MVT string pool (1.55% of tile bytes) while the
quantised scores cost 28,512 (0.34%), so the swap makes the archive about 20 MB
SMALLER while adding the data.

Scores are 0..255. This is the third tie-breaker in place-rank.ts, after
containment and category, so a byte decides every tie a float would.

Reads the map as `numeric_qid<TAB>score` from the path in argv[1], then filters
GeoJSONSeq on stdin to stdout.
"""
import json
import sys

table_path = sys.argv[1]

table = {}
with open(table_path, encoding="ascii") as fh:
    for line in fh:
        qid, score = line.split("\t")
        table[int(qid)] = int(score)

matched = 0
seen_qid = 0
total = 0

out = sys.stdout
for line in sys.stdin:
    stripped = line.strip().lstrip(chr(30))
    if not stripped:
        continue
    total += 1
    try:
        feature = json.loads(stripped)
    except ValueError:
        # A line osmium wrote that we cannot parse is a build bug, not something
        # to silently drop: pass it through and let tippecanoe complain.
        out.write(line)
        continue
    props = feature.get("properties")
    if props is not None:
        qid = props.pop("wikidata", None)
        if isinstance(qid, str) and qid.startswith("Q"):
            seen_qid += 1
            try:
                score = table.get(int(qid[1:]))
            except ValueError:
                score = None
            if score is not None:
                matched += 1
                props["importance"] = score
    # RS-prefixed GeoJSONSeq, matching what osmium emits.
    out.write("\x1e" + json.dumps(feature, separators=(",", ":"), ensure_ascii=False) + "\n")

print(
    f"  importance join: {total:,} features, {seen_qid:,} with a QID, "
    f"{matched:,} matched ({100 * matched / seen_qid if seen_qid else 0:.1f}% of QIDs)",
    file=sys.stderr,
)
