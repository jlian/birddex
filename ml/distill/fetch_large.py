"""Re-download the 3,322 held-out validation photos at LARGE (1024px) size.

Why: the corpus was fetched at iNat "medium", which is 500px on the long side
(SSOT row A3). Every cap/RAM experiment against it is vacuous because a 640px
cap never binds on a 500px image. To measure whether DCT scaled decoding costs
accuracy, we need the SAME photos at a size where downscaling actually happens.

Ground truth is unchanged: same photo ids, same labels, just more pixels.

Rate-limited and resumable, following download_inat.py conventions. iNat photo
URLs are .../square.jpg and the size is a path segment, so "large" is a swap.
"""
import argparse, json, os, sys, time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "WingDex/1.0 (research; contact via github.com/jlian/wingdex)"
ML = "/home/jlian/wingdex/ml"
OUT = os.path.join(ML, "heldout-large")


def build_url(photo_id, ext, size):
    return "https://inaturalist-open-data.s3.amazonaws.com/photos/%s/%s.%s" % (
        photo_id, size, ext)


def fetch(args):
    pid, ext, size, sleep_s = args
    dest = os.path.join(OUT, "%s.%s" % (pid, ext))
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return ("skip", pid, os.path.getsize(dest))
    url = build_url(pid, ext, size)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
        time.sleep(sleep_s)
        return ("ok", pid, len(data))
    except urllib.error.HTTPError as e:
        return ("http%d" % e.code, pid, 0)
    except Exception as e:
        return ("err:%s" % type(e).__name__, pid, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="large", choices=["large", "original", "medium"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--sleep", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    sf = os.environ.get("SPLIT", "val_split_seed0.json")
    split = json.load(open(os.path.join(ML, sf)))
    ids = split.get("have") or [str(x) for x in split["ids"]]
    if a.limit:
        ids = ids[: a.limit]

    # Extension comes from the local copy: iNat keeps the same one per photo.
    jobs = []
    for k in ids:
        if "paths" in split:
            ext = split["paths"][k].rsplit(".", 1)[-1].lower()
        else:
            ext = split["ext"][str(k)]
        jobs.append((str(k).lstrip("p"), ext, a.size, a.sleep))

    print("photos to fetch: %d at size=%s" % (len(jobs), a.size), flush=True)
    print("output: %s" % OUT, flush=True)

    counts = {}
    total_bytes = 0
    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for status, pid, nbytes in ex.map(fetch, jobs):
            counts[status] = counts.get(status, 0) + 1
            total_bytes += nbytes
            done += 1
            if done % 100 == 0:
                el = time.time() - t0
                print("  %d/%d  %.1f req/s  %.2f GB  %s" % (
                    done, len(jobs), done / el, total_bytes / 1e9,
                    ", ".join("%s=%d" % kv for kv in sorted(counts.items()))), flush=True)

    print("", flush=True)
    print("=== done in %.0fs ===" % (time.time() - t0))
    for k, v in sorted(counts.items()):
        print("  %-12s %d" % (k, v))
    print("  total: %.2f GB" % (total_bytes / 1e9))


if __name__ == "__main__":
    main()
