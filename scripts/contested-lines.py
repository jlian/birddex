#!/usr/bin/env python3
"""Find lines whose value keeps returning to something it already was.

Churn alone is a weak signal: a line edited ten times in one direction is
ordinary evolution. A line that flips BACK to an earlier value means people
disagreed, and the reasoning usually never made it into the code. Those lines
are worth a comment.

Method
------
For each line, walk `git log -L` and record the value at the tracked offset in
each commit. `git log -L` follows a drifting range and emits whole hunks, so
reading its output naively attributes the entire file history to every line;
tracking the offset is what makes the result per-line.

Adjustments that matter, each added because its absence produced noise:

- Automated commits are ignored. Release and bot commits cycle version strings
  constantly, which looks like disagreement but is a machine.
- Edits are weighted by commit size. A 12-line commit that changes this line is
  a deliberate decision; a 900-line refactor that sweeps it up is not.
- Adjacent contested lines collapse into one finding. Reindenting a 9-line block
  is one event, not nine decisions.
- Lines are classified logic/style/test. Styling and test assertions churn
  legitimately and almost never encode a decision worth documenting.

Score = (reverts * 3 + distinct values) * focus, divided by sqrt(run length).

The "is it documented?" check looks in three places, because a comment does not
have to sit next to the line, it has to sit where a reader would look: nearby,
at the top of the enclosing block, or above the definition of an identifier the
line uses. A constant explained at its declaration 115 lines away is documented.

Usage
-----
  scripts/contested-lines.py                        whole repo, default globs
  scripts/contested-lines.py --jobs 14              parallel across files
  scripts/contested-lines.py --out findings.json    machine-readable output
  scripts/contested-lines.py --min-reverts 0        include non-reverted churn
  scripts/contested-lines.py 'src/**/*.tsx'         restrict to a glob

Runs over ~330 files in about 50s on 14 cores, or 20 minutes single-threaded.
Read-only: it only ever runs `git log`.

Note that this finds contested INFRASTRUCTURE more readily than contested
logic. New code returns nothing because nobody has disagreed about it yet.
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import time

HUNK = re.compile(r"^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@")
REPO = os.environ.get("HOTSCAN_REPO", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
META = {}
MIN_REVERTS = int(os.environ.get("HOTSCAN_MIN_REVERTS", "1"))

AUTO_PAT = re.compile(r"^(chore\(Release\)|chore: release|chore\(deps|Merge |Revert )", re.I)
BOT_PAT = re.compile(r"(\[bot\]|dependabot|semantic-release|github-actions)", re.I)

def sh(args):
    return subprocess.run(args, cwd=REPO, capture_output=True, text=True).stdout

def load_commit_meta():
    """One pass over history: sha -> (is_automated, churn_size). Cheap, reused."""
    out = sh(["git", "log", "--all", "--format=@@%H|%an|%s", "--numstat"])
    meta = {}
    sha = None
    for line in out.splitlines():
        if line.startswith("@@"):
            parts = line[2:].split("|", 2)
            sha = parts[0]
            author = parts[1] if len(parts) > 1 else ""
            subject = parts[2] if len(parts) > 2 else ""
            auto = bool(AUTO_PAT.match(subject)) or bool(BOT_PAT.search(author))
            meta[sha] = [auto, 0]
            continue
        if sha and line.strip():
            cols = line.split()
            if len(cols) >= 2:
                for c in cols[:2]:
                    if c.isdigit():
                        meta[sha][1] += int(c)
    return meta

def focus(size):
    if size <= 25:
        return 1.0
    if size <= 120:
        return 0.6
    if size <= 500:
        return 0.3
    return 0.12

def norm(v):
    return " ".join(v.split())

def value_history(path, lineno):
    """[(sha, value)] at the tracked offset, oldest first, automated commits dropped."""
    out = sh(["git", "log", "--reverse", "--format=@@C@@%H", "-L",
              "%d,%d:%s" % (lineno, lineno, path)])
    values = []
    sha = None
    in_hunk = False
    target = None
    cursor = None
    for raw in out.splitlines():
        if raw.startswith("@@C@@"):
            sha = raw[5:].strip()
            in_hunk = False
            continue
        m = HUNK.match(raw)
        if m:
            target = int(m.group(3))
            cursor = target
            in_hunk = True
            continue
        if not in_hunk or not sha:
            continue
        if raw.startswith("-"):
            continue
        if raw.startswith("+") or raw.startswith(" "):
            body = raw[1:]
            if cursor == target and body.strip():
                info = META.get(sha)
                if not info or not info[0]:
                    values.append((sha, norm(body)))
                in_hunk = False
            cursor += 1
    return values

def contested(values):
    """(reverts, distinct, focus_avg) over value CHANGES only."""
    chain = []
    changers = []
    for sha, v in values:
        if not chain or v != chain[-1]:
            chain.append(v)
            changers.append(sha)
    reverts = 0
    for i, v in enumerate(chain):
        if v in chain[:max(0, i - 1)]:
            reverts += 1
    if changers:
        f = sum(focus(META.get(s, [False, 999])[1]) for s in changers) / len(changers)
    else:
        f = 0.0
    return reverts, len(set(chain)), f

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
COMMENT_START = ("#", "//", "*", "/*", "///")


def _is_comment(t):
    return t.startswith(COMMENT_START)


def documented(lines, idx, radius=3):
    """Is the reason for this line written down anywhere a reader would look?

    A fixed 3-line window is far too narrow, and produced two false positives on
    the first real run: the thumbnail lazy-load ternary is explained at the
    constant it reads, 115 lines up, and the passkey cookie call is explained by a
    block comment 10 lines above the statement. Both were reported as
    undocumented. Check three places instead:

      1. a comment within `radius` lines above
      2. a comment at the top of the enclosing block (walk up while indentation
         is deeper than this line, which covers multi-line statements)
      3. a comment above the DEFINITION of any identifier the line uses, which
         is where a constant like SHOULD_LAZY_LOAD_THUMBNAILS carries its reason
    """
    # 1. immediate neighbourhood
    for j in range(max(0, idx - 1 - radius), idx - 1):
        if _is_comment(lines[j].strip()):
            return True

    # 2. enclosing block: walk up while more-indented, then look just above
    def indent(t):
        return len(t) - len(t.lstrip())

    base = indent(lines[idx - 1])
    j = idx - 2
    steps = 0
    while j >= 0 and steps < 40:
        t = lines[j]
        if not t.strip():
            j -= 1
            steps += 1
            continue
        if _is_comment(t.strip()):
            return True
        if indent(t) < base:
            for k in range(max(0, j - 4), j):
                if _is_comment(lines[k].strip()):
                    return True
            break
        j -= 1
        steps += 1

    # 3. definition sites of identifiers used on this line
    names = set(IDENT.findall(lines[idx - 1]))
    if not names:
        return False
    for j, t in enumerate(lines):
        if j == idx - 1:
            continue
        st = t.strip()
        if not st or _is_comment(st):
            continue
        for kw in ("const ", "let ", "var ", "func ", "function ", "def "):
            if st.startswith(kw):
                decl = st[len(kw):].split("=")[0].split("(")[0].split(":")[0].strip()
                if decl and decl in names:
                    for k in range(max(0, j - 4), j):
                        if _is_comment(lines[k].strip()):
                            return True
                break
    return False

SKIP = ("#", "//", "*", "/*", "import ", "from ", "export {", "}", "};", ")", "],", "})")

# Filtering by FILE EXTENSION does not separate signal: ts/tsx/swift/yml all
# carry both real decisions and pure churn. Filtering by what the LINE IS works
# much better. Styling churn is real churn but never encodes a decision worth a
# comment; test assertions change legitimately whenever behaviour changes.
STYLE_PAT = re.compile(
    r'className=|\.padding\(|\.font\(|\.frame\(|\.foregroundStyle|\.cornerRadius'
    r'|<div |<span |<VStack|<HStack|gap-|text-|bg-|px-|py-|rounded|shadow-',
    re.I,
)
TEST_PAT = re.compile(
    r'expect\(|await page|getByRole|getByPlaceholder|getByText|describe\(|it\(|toBe\('
)

def classify(path, src):
    if '.spec.' in path or '.test.' in path or TEST_PAT.search(src):
        return 'test'
    if STYLE_PAT.search(src):
        return 'style'
    return 'logic'

def scan_file(path):
    full = os.path.join(REPO, path)
    try:
        lines = open(full, encoding="utf-8", errors="ignore").read().splitlines()
    except (IOError, OSError):
        return []
    if len(lines) > 4000:
        return []
    hits = []
    for i in range(1, len(lines) + 1):
        s = lines[i - 1].strip()
        if len(s) < 8 or s.startswith(SKIP):
            continue
        vals = value_history(path, i)
        if len(vals) < 3:
            continue
        reverts, distinct, f = contested(vals)
        if reverts < MIN_REVERTS or f < 0.25:
            continue
        hits.append({
            "line": i,
            "reverts": reverts,
            "distinct": distinct,
            "edits": len(vals),
            "focus": round(f, 2),
            "src": s[:88],
            "documented": documented(lines, i),
            "kind": classify(path, s),
            "raw": (reverts * 3 + distinct) * f,
        })
    return collapse(path, hits)

def collapse(path, hits):
    """Merge adjacent contested lines into one run; a block reformat scores once."""
    if not hits:
        return []
    runs = []
    cur = [hits[0]]
    for h in hits[1:]:
        if h["line"] - cur[-1]["line"] <= 2:
            cur.append(h)
        else:
            runs.append(cur)
            cur = [h]
    runs.append(cur)
    out = []
    for run in runs:
        best = max(run, key=lambda r: r["raw"])
        penalty = 1.0 / (len(run) ** 0.5)
        out.append({
            "path": path,
            "line": best["line"],
            "score": round(best["raw"] * penalty, 1),
            "reverts": best["reverts"],
            "edits": best["edits"],
            "focus": best["focus"],
            "run": len(run),
            "src": best["src"],
            "documented": best["documented"],
            "kind": best["kind"],
        })
    return out

def main():
    global META
    args = list(sys.argv[1:])
    jobs = 4
    if "--jobs" in args:
        k = args.index("--jobs")
        jobs = int(args[k + 1])
        del args[k:k + 2]
    out_path = None
    if "--out" in args:
        k = args.index("--out")
        out_path = args[k + 1]
        del args[k:k + 2]
    global MIN_REVERTS
    if "--min-reverts" in args:
        k = args.index("--min-reverts")
        MIN_REVERTS = int(args[k + 1])
        del args[k:k + 2]
    globs = args or ["*.ts", "*.tsx", "*.swift", "*.yml", "*.sh"]

    print("loading commit metadata...", flush=True)
    META = load_commit_meta()
    auto = sum(1 for v in META.values() if v[0])
    print("  %d commits, %d automated (ignored)" % (len(META), auto), flush=True)

    files = [f for f in sh(["git", "ls-files"] + globs).splitlines()
             if f and "node_modules" not in f]
    print("scanning %d files with %d workers" % (len(files), jobs), flush=True)

    t0 = time.time()
    rows = []
    done = 0
    with cf.ProcessPoolExecutor(max_workers=jobs) as pool:
        for res in pool.map(scan_file, files, chunksize=1):
            rows.extend(res)
            done += 1
            if done % 50 == 0:
                print("  %d/%d, %d findings, %.0fs" % (done, len(files), len(rows), time.time() - t0), flush=True)
    rows.sort(key=lambda r: -r["score"])
    print("done in %.0fs, %d findings" % (time.time() - t0, len(rows)), flush=True)

    if out_path:
        with open(out_path, "w") as fh:
            json.dump(rows, fh, indent=1)
        print("wrote", out_path)
    for r in rows[:15]:
        print("%-6.1f %-6s %-22s :%-5d rev=%d ed=%d doc=%-3s %s" % (
            r["score"], r["kind"], r["path"][-22:], r["line"], r["reverts"], r["edits"],
            "yes" if r["documented"] else "NO", r["src"][:50]))

main()
