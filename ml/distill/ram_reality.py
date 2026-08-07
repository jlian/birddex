"""Measure the RAM reality of DCT scaled decode on REAL large photos.

The corpus photos are 2048px, which understates the win. These 27 assets go up
to 25.6 MP, which is the alpha-6700 case that started the whole RAM thread.

Reports the decoded bitmap size, which is what actually sits in memory, not the
JPEG file size. A 25.6 MP RGBA bitmap is ~102 MB regardless of a 6 MB file.
"""
import glob, os, time
import tracemalloc
from PIL import Image

SRC = "/home/jlian/wingdex/src/assets/images"
files = sorted(glob.glob(os.path.join(SRC, "*")))
files = [f for f in files if f.lower().rsplit(".", 1)[-1] in ("jpg", "jpeg", "png")]


def measure(path, cap):
    tracemalloc.start()
    t = time.time()
    im = Image.open(path)
    full = im.size
    if cap:
        im.draft("RGB", (cap, cap))
    decoded = im.size
    im = im.convert("RGB")
    el = time.time() - t
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    return full, decoded, el, peak


print("%-46s %11s %11s %8s %8s" % ("photo", "full MP", "decoded MP", "RGBA MB", "ms"))
tot_full = 0.0
tot_cap = 0.0
tot_ms_full = 0.0
tot_ms_cap = 0.0
for f in files:
    full, _, el0, _ = measure(f, 0)
    _, dec, el1, _ = measure(f, 500)
    mp_full = full[0] * full[1] / 1e6
    mp_cap = dec[0] * dec[1] / 1e6
    tot_full += mp_full
    tot_cap += mp_cap
    tot_ms_full += el0 * 1000
    tot_ms_cap += el1 * 1000
    name = os.path.basename(f)[:44]
    print("%-46s %11.1f %11.2f %8.1f %8.0f" % (
        name, mp_full, mp_cap, mp_full * 4, el0 * 1000))

n = len(files)
print("")
print("=== TOTALS over %d photos ===" % n)
print("  full decode:   %8.1f MP   RGBA %7.0f MB   %6.0f ms" % (
    tot_full, tot_full * 4, tot_ms_full))
print("  DCT cap 500:   %8.1f MP   RGBA %7.0f MB   %6.0f ms" % (
    tot_cap, tot_cap * 4, tot_ms_cap))
print("  reduction:     %8.1fx pixels, %.1fx memory, %.2fx time" % (
    tot_full / max(tot_cap, 1e-9), tot_full / max(tot_cap, 1e-9),
    tot_ms_full / max(tot_ms_cap, 1e-9)))
print("")
print("  WORST CASE single photo:")
w = max(files, key=lambda f: measure(f, 0)[0][0] * measure(f, 0)[0][1])
fu, de, _, _ = measure(w, 0)
_, de2, _, _ = measure(w, 500)
print("    %s" % os.path.basename(w))
print("    full %d x %d = %.1f MP -> RGBA %.0f MB" % (
    fu[0], fu[1], fu[0] * fu[1] / 1e6, fu[0] * fu[1] * 4 / 1e6))
print("    cap  %d x %d = %.2f MP -> RGBA %.0f MB" % (
    de2[0], de2[1], de2[0] * de2[1] / 1e6, de2[0] * de2[1] * 4 / 1e6))
