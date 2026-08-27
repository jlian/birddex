#!/usr/bin/env python3
"""
Build a WingDex place extract from the Wikidata truthy dump.

Runs on Tomahawk, never on the Pi: the input is 43 GB compressed and is streamed
line by line, never loaded into memory. Output is tens of MB.

Why this replaced the WDQS puller: a P31/P279* traversal over a large subclass
tree (lake, protected area) cannot finish inside the WDQS 60 second deadline, so
those classes returned 504 no matter how small the page size got. Offline the
same traversal is just a graph walk.

Three passes over the dump, because the class closure has to exist before we can
decide which items to keep:

  pass 1  P279 edges          -> transitive closure of the allowlisted roots
  pass 2  P31 for items in that closure, plus P625 coordinates
  pass 3  English labels for the surviving items only

Importance comes from Nominatim's own wikimedia-importance.csv.gz rather than
being approximated: it carries a wikidata_id column, so it joins directly on QID.
"""
import bz2
import gzip
import json
import re
import subprocess
import sys
from collections import defaultdict

DUMP = '/mnt/nas/wikidata/latest-truthy.nt.bz2'
IMPORTANCE = '/mnt/nas/wikidata/wikimedia-importance.csv.gz'
OUT = '/mnt/nas/wikidata/places.ndjson'

# Roots come from scripts/wikidata-places/classes.ts. Kept in sync by hand for
# the prototype; the TypeScript file remains the source of truth.
ROOTS = {
    'Q46169': ('national park', 15000),
    'Q473972': ('protected area', 10000),
    'Q179049': ('nature reserve', 6000),
    'Q4421': ('forest', 8000),
    'Q23397': ('lake', 4000),
    'Q170321': ('marsh', 3000),
    'Q39594': ('bay', 5000),
    'Q23442': ('island', 8000),
    'Q40080': ('beach', 2000),
    'Q185113': ('cape', 3000),
    'Q8072': ('volcano', 8000),
    'Q8502': ('mountain', 6000),
    'Q22698': ('park', 2000),
    'Q167346': ('botanical garden', 1500),
    'Q1107656': ('garden', 1000),
}

ENT = 'http://www.wikidata.org/entity/'
P31 = '<http://www.wikidata.org/prop/direct/P31>'
P279 = '<http://www.wikidata.org/prop/direct/P279>'
P625 = '<http://www.wikidata.org/prop/direct/P625>'
LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>'

POINT_RE = re.compile(r'Point\(([-\d.eE]+) ([-\d.eE]+)\)')
LABEL_RE = re.compile(r'"((?:[^"\\]|\\.)*)"@en \.$')


def qid(uri: str) -> str:
    """<http://www.wikidata.org/entity/Q42> -> Q42, else ''."""
    if uri.startswith('<' + ENT) and uri.endswith('>'):
        return uri[len(ENT) + 1:-1]
    return ''


def stream(path: str):
    """Decompress with lbzip2 (parallel). pbzip2 cannot decompress files it did
    not compress, and plain bzip2 is single threaded and far too slow here."""
    proc = subprocess.Popen(
        ['lbzip2', '-dc', path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1024 * 1024,
    )
    for raw in proc.stdout:
        yield raw.decode('utf-8', 'replace')
    proc.wait()
    # A truncated or corrupt dump makes lbzip2 exit non-zero AFTER emitting a
    # partial stream. Ignoring that status let all three passes finish normally
    # and write a plausible but incomplete extract, which is the worst outcome:
    # it looks like a successful build. Fail loudly instead.
    if proc.returncode != 0:
        detail = (proc.stderr.read() or b'').decode('utf-8', 'replace').strip()
        raise RuntimeError(
            f'lbzip2 failed on {path} with exit {proc.returncode}; '
            f'the stream was truncated so the extract would be incomplete. {detail}'
        )


def pass1_closure() -> dict:
    """Map every subclass QID to the root it descends from."""
    children = defaultdict(list)
    n = 0
    for line in stream(DUMP):
        n += 1
        if P279 not in line:
            continue
        parts = line.split(' ', 2)
        if len(parts) < 3 or parts[1] != P279:
            continue
        child = qid(parts[0])
        parent = qid(parts[2].rstrip(' .\n'))
        if child and parent:
            children[parent].append(child)
        if n % 100_000_000 == 0:
            print(f'  pass1 {n // 1_000_000}M lines, {len(children)} parents', flush=True)

    cls_of = {}
    for root in ROOTS:
        stack = [root]
        seen = set()
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            # First root wins: a class reachable from two roots keeps the first,
            # which is stable because ROOTS iterates in insertion order.
            cls_of.setdefault(cur, root)
            stack.extend(children.get(cur, ()))
    print(f'  closure: {len(cls_of)} classes from {len(ROOTS)} roots', flush=True)
    return cls_of


def pass2_items(cls_of: dict):
    """Items whose P31 lands in the closure, plus their coordinates."""
    item_cls = {}
    coords = {}
    n = 0
    for line in stream(DUMP):
        n += 1
        if P31 in line:
            parts = line.split(' ', 2)
            if len(parts) >= 3 and parts[1] == P31:
                cls = cls_of.get(qid(parts[2].rstrip(' .\n')))
                if cls:
                    item_cls.setdefault(qid(parts[0]), cls)
        elif P625 in line:
            parts = line.split(' ', 2)
            if len(parts) >= 3 and parts[1] == P625:
                m = POINT_RE.search(parts[2])
                if m:
                    q = qid(parts[0])
                    if q:
                        coords[q] = (float(m.group(2)), float(m.group(1)))
        if n % 100_000_000 == 0:
            print(f'  pass2 {n // 1_000_000}M lines, {len(item_cls)} items, {len(coords)} coords', flush=True)

    keep = {q: c for q, c in item_cls.items() if q in coords}
    print(f'  matched: {len(item_cls)} items, {len(keep)} with coordinates', flush=True)
    return keep, coords


def pass3_labels(keep: dict) -> dict:
    """English labels, for surviving items only."""
    labels = {}
    n = 0
    for line in stream(DUMP):
        n += 1
        if LABEL not in line:
            continue
        parts = line.split(' ', 2)
        if len(parts) < 3 or parts[1] != LABEL:
            continue
        q = qid(parts[0])
        if q not in keep:
            continue
        m = LABEL_RE.search(parts[2].rstrip('\n'))
        if m:
            labels[q] = m.group(1).encode().decode('unicode_escape')
        if n % 100_000_000 == 0:
            print(f'  pass3 {n // 1_000_000}M lines, {len(labels)} labels', flush=True)
    print(f'  labels: {len(labels)}', flush=True)
    return labels


def load_importance(keep: dict) -> dict:
    """Nominatim importance, joined on QID.

    The file carries several rows per item (one per language, plus redirects), so
    take English articles only: language=en, type=a.
    """
    out = {}
    with gzip.open(IMPORTANCE, 'rt', encoding='utf-8', errors='replace') as fh:
        next(fh, None)
        for line in fh:
            f = line.rstrip('\n').split('\t')
            if len(f) < 5 or f[0] != 'en' or f[1] != 'a':
                continue
            q = f[4]
            if q in keep:
                try:
                    out[q] = float(f[3])
                except ValueError:
                    pass
    print(f'  importance: {len(out)} of {len(keep)} items ({100 * len(out) / max(1, len(keep)):.1f}%)', flush=True)
    return out


def main():
    print('pass 1: subclass closure', flush=True)
    cls_of = pass1_closure()

    print('pass 2: items and coordinates', flush=True)
    keep, coords = pass2_items(cls_of)

    print('pass 3: labels', flush=True)
    labels = pass3_labels(keep)

    print('join: importance', flush=True)
    importance = load_importance(keep)

    written = 0
    with open(OUT, 'w', encoding='utf-8') as fh:
        for q, cls in keep.items():
            name = labels.get(q)
            # An item with no English label would be named by its QID, which is
            # useless as an outing name.
            if not name:
                continue
            lat, lon = coords[q]
            fh.write(json.dumps({
                'qid': q,
                'name': name,
                'lat': lat,
                'lon': lon,
                'cls': cls,
                'importance': importance.get(q, 0.0),
            }) + '\n')
            written += 1
    print(f'wrote {written} places -> {OUT}', flush=True)


if __name__ == '__main__':
    main()
