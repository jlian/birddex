#!/usr/bin/env python3
"""Map NABirds leaf categories -> our eBird-anchored taxonomy index."""
import json, os, re, argparse


ALIASES = {
    "black-crowned night-heron": "black-crowned night heron",
    "yellow-crowned night-heron": "yellow-crowned night heron",
    "herring gull": "american herring gull",
    "mew gull": "short-billed gull",
    "cattle egret": "western cattle-egret",
    "whimbrel": "hudsonian whimbrel",
    "common ground-dove": "common ground dove",
    "barn owl": "american barn owl",
    "northwestern crow": "american crow",
    "house wren": "northern house wren",
    "yellow warbler": "northern yellow warbler",
    "common redpoll": "redpoll",
    "hoary redpoll": "redpoll",
    "pacific-slope flycatcher": "western flycatcher",
    "cordilleran flycatcher": "western flycatcher",
    "warbling vireo": "eastern warbling vireo",
    "gray jay": "canada jay",
    "western scrub-jay": "california scrub-jay",
}

def load_classes(meta):
    classes = {}
    for line in open(os.path.join(meta, "classes.txt")):
        parts = line.strip().split(" ", 1)
        if len(parts) == 2: classes[int(parts[0])] = parts[1]
    return classes

def load_hierarchy(meta):
    par = {}
    for line in open(os.path.join(meta, "hierarchy.txt")):
        c, p = line.split()
        par[int(c)] = int(p)
    return par

def species_name(cid, classes, parent):
    # strip (sex/age/morph) qualifier; NABirds species name is the leaf w/o parens
    name = re.sub(r"\s*\(.*\)", "", classes[cid]).strip()
    return name

def build(meta, taxonomy_path):
    classes = load_classes(meta); parent = load_hierarchy(meta)
    taxo = json.load(open(taxonomy_path))
    common_to_idx = {r[0].lower(): i for i,r in enumerate(taxo)}
    labels = sorted({int(l.split()[1]) for l in open(os.path.join(meta,"image_class_labels.txt"))})
    mapping = {}; unmatched = []
    for cid in labels:
        sp = species_name(cid, classes, parent)
        key = sp.lower()
        idx = common_to_idx.get(key)
        if idx is None and key in ALIASES:
            idx = common_to_idx.get(ALIASES[key])
        if idx is not None: mapping[cid] = idx
        else: unmatched.append((cid, sp))
    return mapping, unmatched, classes

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", default="nabirds_meta")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--out", default="nabirds_to_taxo.json")
    a = ap.parse_args()
    m, un, classes = build(a.meta, a.taxonomy)
    json.dump(m, open(a.out,"w"))
    print(f"mapped {len(m)}/{len(m)+len(un)} NABirds leaf categories to taxonomy")
    print(f"unmatched {len(un)} (sample): {un[:12]}")
