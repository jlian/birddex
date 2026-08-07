import json, sys
import pandas as pd

src = sys.argv[1]
dst = sys.argv[2]
d = pd.read_parquet(src)
n = 0
with open(dst, "w") as f:
    for r in d.itertuples():
        rec = {
            "photo_id": int(r.photo_id),
            "latitude": float(r.latitude),
            "longitude": float(r.longitude),
            "cand_idx": [int(x) for x in r.cand_idx],
        }
        f.write(json.dumps(rec) + chr(10))
        n += 1
print("wrote %d rows to %s" % (n, dst))
