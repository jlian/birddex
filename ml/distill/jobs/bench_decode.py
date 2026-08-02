import glob
import io
import tarfile
import time
from collections import Counter
from PIL import Image

import PIL
print("Pillow:", PIL.__version__)
try:
    from PIL import features
    print("libjpeg_turbo:", features.check_feature("libjpeg_turbo"))
    print("jpg support  :", features.check("jpg"))
except Exception as e:
    print("feature check failed:", e)

SH = sorted(glob.glob("/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"))[0]
print("sampling from:", SH.split("/")[-1])

blobs = []
with tarfile.open(SH) as tf:
    for m in tf:
        if m.name.endswith(".jpg"):
            blobs.append(tf.extractfile(m).read())
        if len(blobs) >= 300:
            break
print("sampled", len(blobs), "jpegs")

sizes = Counter()
byts = 0
for b in blobs:
    im = Image.open(io.BytesIO(b))
    sizes[im.size] += 1
    byts += len(b)
print("avg bytes/img: %.1f KB" % (byts / len(blobs) / 1024))
print("top source dimensions:")
for s, c in sizes.most_common(6):
    print("   %sx%s : %d" % (s[0], s[1], c))

# --- decode-only, as the loader does today ---
t0 = time.time()
for b in blobs:
    Image.open(io.BytesIO(b)).convert("RGB")
t1 = time.time()
full = t1 - t0
print("")
print("decode FULL size      : %.1f img/s  (%.2f ms/img)"
      % (len(blobs) / full, 1000 * full / len(blobs)))

# --- decode with PIL draft(), which lets libjpeg downscale DURING decode ---
t0 = time.time()
for b in blobs:
    im = Image.open(io.BytesIO(b))
    im.draft("RGB", (256, 256))
    im.convert("RGB")
t1 = time.time()
draft = t1 - t0
print("decode WITH draft 256 : %.1f img/s  (%.2f ms/img)  -> %.2fx faster"
      % (len(blobs) / draft, 1000 * draft / len(blobs), full / draft))

# --- what a pre-resized shard would cost to decode (simulate 384px jpegs) ---
small = []
for b in blobs[:150]:
    im = Image.open(io.BytesIO(b)).convert("RGB")
    im.thumbnail((384, 384))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    small.append(buf.getvalue())
sb = sum(len(x) for x in small) / len(small) / 1024
t0 = time.time()
for b in small:
    Image.open(io.BytesIO(b)).convert("RGB")
t1 = time.time()
pre = t1 - t0
print("decode PRE-RESIZED 384: %.1f img/s  (%.2f ms/img)  -> %.2fx faster"
      % (len(small) / pre, 1000 * pre / len(small), (full / len(blobs)) / (pre / len(small))))
print("   avg bytes/img: %.1f KB (was %.1f KB)" % (sb, byts / len(blobs) / 1024))
