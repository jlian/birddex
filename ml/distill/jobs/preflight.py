import json
import os
import glob

ok = True

def chk(label, cond, detail=""):
    global ok
    print("  [%s] %-42s %s" % ("PASS" if cond else "FAIL", label, detail))
    if not cond:
        ok = False

print("=== NABirds eval assets ===")
chk("nabirds/ dir", os.path.isdir("nabirds"))
for f in ("nabirds/image_class_labels.txt", "nabirds/train_test_split.txt",
          "nabirds/images.txt"):
    chk(f, os.path.exists(f))
chk("nabirds_to_taxo.json", os.path.exists("nabirds_to_taxo.json"))
chk("nabirds_teacher_cache.npz", os.path.exists("nabirds_teacher_cache.npz"),
    "%.0f MB" % (os.path.getsize("nabirds_teacher_cache.npz") / 1e6
                 if os.path.exists("nabirds_teacher_cache.npz") else 0))
chk("taxonomy.json", os.path.exists("/home/jlian/wingdex/src/lib/taxonomy.json"))

nb = json.load(open("nabirds_to_taxo.json"))
mapped = sum(1 for v in nb.values() if v is not None)
chk("nabirds->taxo mapping", mapped > 300, "%d classes mapped" % mapped)

print("")
print("=== corpus / shards ===")
sh = sorted(glob.glob("/mnt/nas/WingDex-Distill/wds/shard-*.tar"))
chk("full corpus shards", len(sh) == 251, "%d found" % len(sh))
bad = [f for f in sh if os.path.getsize(f) < 1000]
chk("no truncated shards", not bad, "%d suspicious" % len(bad))

print("")
print("=== held-out eval set ===")
for f in ("groundtruth_heldout.parquet", "groundtruth_heldout_distilled.parquet",
          "calib_untouched.parquet"):
    chk(f, os.path.exists(f))

print("")
print("=== teacher checkpoint ===")
chk("wise_a0.90.pt", os.path.exists("runs/ft_clean_01/wise_a0.90.pt"))

print("")
print("=== disk headroom ===")
st = os.statvfs("/home/jlian")
free = st.f_bavail * st.f_frsize / 1e9
chk("local free space", free > 40, "%.0f GB free (need ~15 for embeddings+ckpts)" % free)
st2 = os.statvfs("/mnt/nas")
free2 = st2.f_bavail * st2.f_frsize / 1e12
chk("NAS free space", free2 > 1, "%.1f TB free" % free2)

print("")
print("OVERALL:", "READY" if ok else "PROBLEMS FOUND")
