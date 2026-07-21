#!/usr/bin/env python3
"""Select target species for distillation and resolve iNat taxon IDs.

WingDex taxonomy (src/lib/taxonomy.json, mirrored here as taxonomy.json) is the
source of truth: 11,167 species as
  [common, scientific, ebird, wiki_common, thumb, wiki_id]
Student class indices MUST match this list's order so the distilled model plugs
into the app's existing candidate/range pipeline unchanged.

This script:
  1. Loads the app taxonomy (ordered, index = class id).
  2. For each species, looks up its iNaturalist taxon id + observation count by
     scientific name (Aves only, iconic_taxon_id=3), rate-limited & resumable.
  3. Ranks by iNat observation count (proxy for "birds people photograph") and
     writes species.json with the top-N selected for the first corpus pass,
     plus the full resolved table for later long-tail expansion.

Usage:
  python select_species.py --resolve            # resolve all iNat ids (slow, resumable)
  python select_species.py --select --top 2000  # pick top-N by obs count
  python select_species.py --resolve --select --top 2000
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TAXO = os.path.join(HERE, "taxonomy.json")
RESOLVED = os.path.join(HERE, "inat_resolved.jsonl")   # one row per resolved app species
SPECIES = os.path.join(HERE, "species.json")           # final selected set

INAT_TAXA = "https://api.inaturalist.org/v1/taxa"
USER_AGENT = "WingDex-distill/0.1 (research; github.com/jlian/wingdex)"


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def resolve_one(scientific):
    """Return (taxon_id, observations_count, matched_name) or (None, 0, None)."""
    q = urllib.parse.urlencode({
        "q": scientific,
        "rank": "species",
        "iconic_taxa": "Aves",
        "per_page": 5,
    })
    data = _get(f"{INAT_TAXA}?{q}")
    for res in data.get("results", []):
        # Prefer an exact scientific-name match; iNat 'name' is the sci name.
        if res.get("name", "").lower() == scientific.lower():
            return res["id"], res.get("observations_count", 0), res["name"]
    # Fall back to the first Aves species result (synonym / spelling drift).
    for res in data.get("results", []):
        if res.get("iconic_taxon_name") == "Aves":
            return res["id"], res.get("observations_count", 0), res["name"]
    return None, 0, None


def load_taxonomy(path):
    taxo = json.load(open(path))
    return [
        {"idx": i, "common": row[0], "scientific": row[1], "ebird": row[2]}
        for i, row in enumerate(taxo)
    ]


def cmd_resolve(args):
    taxo = load_taxonomy(args.taxonomy)
    done = {}
    if os.path.exists(RESOLVED):
        for line in open(RESOLVED):
            r = json.loads(line)
            done[r["idx"]] = r
    print(f"{len(done)}/{len(taxo)} already resolved", flush=True)

    with open(RESOLVED, "a") as out:
        for sp in taxo:
            if sp["idx"] in done:
                continue
            try:
                tid, count, matched = resolve_one(sp["scientific"])
            except Exception as e:  # noqa: BLE001 - network flakiness, keep going
                print(f"  ! {sp['scientific']}: {e}", flush=True)
                time.sleep(args.sleep * 4)
                continue
            row = {
                "idx": sp["idx"],
                "common": sp["common"],
                "scientific": sp["scientific"],
                "ebird": sp["ebird"],
                "inat_taxon_id": tid,
                "observations_count": count,
                "inat_matched_name": matched,
            }
            out.write(json.dumps(row) + "\n")
            out.flush()
            if sp["idx"] % 50 == 0:
                print(f"  {sp['idx']}/{len(taxo)}  {sp['scientific']} -> {tid} ({count} obs)", flush=True)
            time.sleep(args.sleep)
    print("resolve complete", flush=True)


def cmd_select(args):
    if not os.path.exists(RESOLVED):
        sys.exit("run --resolve first")
    rows = [json.loads(l) for l in open(RESOLVED)]
    resolved = [r for r in rows if r.get("inat_taxon_id")]
    resolved.sort(key=lambda r: r.get("observations_count", 0), reverse=True)
    selected = resolved[: args.top]
    json.dump(
        {
            "total_app_species": len(rows),
            "resolved": len(resolved),
            "selected": len(selected),
            "species": selected,
        },
        open(SPECIES, "w"),
        indent=1,
    )
    print(f"selected {len(selected)} / {len(resolved)} resolved -> {SPECIES}", flush=True)
    print("top 10:", flush=True)
    for r in selected[:10]:
        print(f"  {r['common']:32s} {r['observations_count']:>9,} obs  taxon={r['inat_taxon_id']}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", default=DEFAULT_TAXO)
    ap.add_argument("--resolve", action="store_true")
    ap.add_argument("--select", action="store_true")
    ap.add_argument("--top", type=int, default=2000)
    ap.add_argument("--sleep", type=float, default=1.1, help="seconds between iNat calls")
    args = ap.parse_args()
    if not (args.resolve or args.select):
        ap.error("pass --resolve and/or --select")
    if args.resolve:
        cmd_resolve(args)
    if args.select:
        cmd_select(args)


if __name__ == "__main__":
    main()
