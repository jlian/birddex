#!/usr/bin/env python3
"""
Extract containment edges (P131, P276) for places already in the extract.

Parallel by design, unlike build_extract.py. That script pegged ONE Python core
at 100% while lbzip2 sat at 599% across 19 threads, so Python was the bottleneck
and 10 of 16 cores idled. Two changes fix it:

  1. A grep -F prefilter drops ~99.9% of lines before Python sees them. Only two
     predicates matter here, and fixed-string matching in C beats str.split() in
     a Python loop by a wide margin.
  2. lbzip2 gets all 16 cores, since it is now genuinely the slow part.

One pass, not three: the QIDs to keep are already known from places.ndjson.
"""
import json
import os
import subprocess
import sys
from collections import Counter

DUMP = "/mnt/nas/wikidata/latest-truthy.nt.bz2"
PLACES = "/mnt/nas/wikidata/places.ndjson"
OUT = "/mnt/nas/wikidata/containment.ndjson"

P131 = "http://www.wikidata.org/prop/direct/P131"
P276 = "http://www.wikidata.org/prop/direct/P276"
ENT = "http://www.wikidata.org/entity/"


def qid(uri):
    if uri.startswith("<" + ENT) and uri.endswith(">"):
        return uri[len(ENT) + 1:-1]
    return ""


def main():
    places = {}
    with open(PLACES, encoding="utf-8") as fh:
        for line in fh:
            r = json.loads(line)
            places[r["qid"]] = r["cls"]
    print("places in extract: %d" % len(places), flush=True)

    # lbzip2 -n 16 | grep -F on the two predicate URIs. grep does the rejecting,
    # so Python only ever sees candidate lines.
    cmd = ("lbzip2 -dc -n 16 %s 2>/dev/null | grep -F -e %s -e %s"
           % (DUMP, "'" + P131 + "'", "'" + P276 + "'"))
    proc = subprocess.Popen(["bash", "-c", cmd], stdout=subprocess.PIPE, bufsize=1 << 20)

    kept = 0
    seen = 0
    by_prop = Counter()
    both_in_extract = 0
    with open(OUT, "w", encoding="utf-8") as out:
        for raw in proc.stdout:
            seen += 1
            parts = raw.decode("utf-8", "replace").split(" ", 2)
            if len(parts) < 3:
                continue
            child = qid(parts[0])
            if child not in places:
                continue
            prop = parts[1][1:-1]
            parent = qid(parts[2].rstrip(" .\n"))
            if not parent:
                continue
            kept += 1
            by_prop[prop.rsplit("/", 1)[-1]] += 1
            # The useful case: BOTH ends are places we could name an outing with,
            # so the container can win over the contained feature.
            inside = parent in places
            if inside:
                both_in_extract += 1
            out.write(json.dumps({
                "child": child,
                "parent": parent,
                "prop": prop.rsplit("/", 1)[-1],
                "parent_in_extract": inside,
            }) + "\n")
            if seen % 5_000_000 == 0:
                print("  scanned %dM candidate lines, kept %d, both-in-extract %d"
                      % (seen // 1_000_000, kept, both_in_extract), flush=True)
    proc.wait()

    print("candidate lines from grep: %d" % seen, flush=True)
    print("edges for extract places:  %d" % kept, flush=True)
    print("  by property: %s" % dict(by_prop), flush=True)
    print("both ends in extract:      %d" % both_in_extract, flush=True)
    print("wrote %s" % OUT, flush=True)


if __name__ == "__main__":
    main()
