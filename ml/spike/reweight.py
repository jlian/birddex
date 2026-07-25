#!/usr/bin/env python3
"""Option 3: hand-labeled range reweighting on BioCLIP top-20.
Mirrors the app: out-of-range x0.65, near-range x0.85 (OUT_OF_RANGE_TRUST /
NEAR_RANGE_TRUST from range-adjust.js). Everything not listed = in-range x1.0.
Only species that could outrank truth need labeling; I label OUT/NEAR sets
per image from known biogeography of each photo location."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "top20.json")))
OUT, NEAR = 0.65, 0.85

# Per image: species in the top-20 that are OUT or NEAR range for that photo's
# actual location. Unlisted = in-range (x1.0). Locations from filenames.
RANGE = {
  # Maui, Hawaii. Chukar is introduced/established in HI. All Asian/S-Am galliforms OUT.
  "Chukar_partridge_near_Haleakala_summit_Maui.jpg": {
    "out": ["Xinjiang Ground-Jay","Przevalski's Partridge","Tibetan Snowcock","Patagonian Tinamou",
            "Snow Partridge","Rock Partridge","Lichtenstein's Sandgrouse","Rufous-chested Dotterel",
            "Altai Snowcock","Himalayan Snowcock","Caucasian Snowcock","Sand Partridge","Puna Tinamou",
            "Sumatran Partridge","Erckel's Spurfowl","Tibetan Partridge","White Eared-Pheasant",
            "Black-faced Sandgrouse","Crowned Sandgrouse"]},
  # Chicago suburb. House Sparrow introduced/ubiquitous. Old-World passerines OUT.
  "House_sparrow_bathing_in_mosaic_fountain_Park_Ridge.jpg": {
    "out": ["House Bunting","Blue Seedeater","Scaly Weaver","Madeira Chaffinch","Socotra Sparrow",
            "Sakalava Weaver","Italian Sparrow","Lesser Striped Swallow","Bob-tailed Weaver",
            "Tinian Monarch","Red-headed Finch","Sri Lanka Swallow","Gray-capped Social-Weaver",
            "Blue-capped Cordonbleu","Yemen Linnet","Corsican Finch","Sudan Golden Sparrow"],
    "near": ["Eurasian Tree Sparrow","Swainson's Sparrow"]},
  # Taipei, Taiwan. Common Kingfisher resident. Other blue kingfishers SE-Asia/island OUT/near.
  "Common_kingfisher_at_Taipei_Zoo.jpeg": {
    "out": ["Javan Blue-banded Kingfisher","Malaysian Blue-banded Kingfisher","Green-and-rufous Kingfisher",
            "Indigo-banded Kingfisher","Malagasy Kingfisher","American Pygmy Kingfisher","Vanuatu Kingfisher",
            "Sula Dwarf-Kingfisher","Philippine Dwarf-Kingfisher","Moluccan Dwarf-Kingfisher",
            "Sangihe Dwarf-Kingfisher","Shining-blue Kingfisher"],
    "near": ["Blyth's Kingfisher","Half-collared Kingfisher","Blue-eared Kingfisher","Blue-capped Kingfisher",
             "Spotted Kingfisher","Brown-breasted Kingfisher"]},
  # Monterey, CA. Brandt's resident. Crowned/Cape/Bank=Africa OUT, Red-faced=AK near.
  "Cormorants_on_rock_Monterey_Harbor_sunset.jpg": {
    "out": ["Crowned Cormorant","Cape Cormorant","African Oystercatcher","Bank Cormorant","Imperial Cormorant",
            "Guanay Cormorant","Chatham Islands Shag","Stewart Island Shag","Canarian Oystercatcher","Inca Tern",
            "Pallas's Cormorant"],
    "near": ["Red-faced Cormorant"]},
  # Skagit Bay, WA. Double-crested resident. But Brandt's/Pelagic/BlackOyc/RhinoAuklet also IN (visual mess).
  "Cormorants_on_navigation_marker_Skagit_Bay.jpg": {
    "out": ["Pallas's Cormorant","Inca Tern","Magellanic Cormorant","Guanay Cormorant","Imperial Cormorant",
            "Peruvian Booby","Belcher's Gull","Pitt Island Shag","Brown Booby"],
    "near": ["Red-faced Cormorant","Black-vented Shearwater"]},
  # Seattle winter. Both goldeneyes present; gulls resident. Barrow's legit in-range (real confusion).
  "Common_goldeneye_at_Discovery_Park_Seattle.jpeg": {
    "out": ["Vega Gull","Mongolian Gull","Armenian Gull","Smew"],
    "near": ["Iceland Gull","Glaucous Gull","Slaty-backed Gull"]},
  # Seattle. Ring-necked/Redhead/Greater Scaup all in-range (real diving-duck confusion). Exotics OUT.
  "Lesser_scaup_hen_on_Union_Bay_Natural_Area.jpg": {
    "out": ["Rosy-billed Pochard","Madagascar Pochard","Southern Pochard","Common Pochard","Ferruginous Duck",
            "Tufted Duck","New Zealand Scaup","Baer's Pochard","West Indian Whistling-Duck","Black-headed Duck"],
    "near": ["Canvasback"]},
}

def mult(img, name):
    r = RANGE.get(img, {})
    if name in r.get("out", []): return OUT
    if name in r.get("near", []): return NEAR
    return 1.0

n=0; raw1=0; raw5=0; adj1=0; adj5=0
print(f"{'image':50} {'raw#1':>5} {'adj#1':>5}  result")
print("-"*95)
for img, d in data.items():
    gt = d["truth"]
    if not gt: continue
    n+=1
    top = d["top20"]  # [name, sim]
    # raw ranking
    raw_names=[t[0] for t in top]
    raw_rank = raw_names.index(gt)+1 if gt in raw_names else 99
    # adjusted
    adj = sorted(((s*mult(img,nm), nm) for nm,s in top), reverse=True)
    adj_names=[a[1] for a in adj]
    adj_rank = adj_names.index(gt)+1 if gt in adj_names else 99
    if raw_rank==1: raw1+=1
    if raw_rank<=5: raw5+=1
    if adj_rank==1: adj1+=1
    if adj_rank<=5: adj5+=1
    tag = "FIXED->1" if (raw_rank!=1 and adj_rank==1) else ("still miss" if adj_rank>5 else ("top5" if adj_rank>1 else ""))
    print(f"{img[:50]:50} {raw_rank:>5} {adj_rank:>5}  {tag}  (adj#1={adj_names[0][:24]})")

print("-"*95)
print(f"N scorable = {n}")
print(f"BioCLIP RAW      top-1 {raw1}/{n} = {raw1/n*100:.0f}%   top-5 {raw5}/{n} = {raw5/n*100:.0f}%")
print(f"BioCLIP +RANGE   top-1 {adj1}/{n} = {adj1/n*100:.0f}%   top-5 {adj5}/{n} = {adj5/n*100:.0f}%")
print(f"GPT-5.4mini (fixtures) top-1 19/{n} = {19/n*100:.0f}%   top-5 20/{n} = {20/n*100:.0f}%")

# --- Crop-trigger signal analysis ---
print("\n=== CROP-TRIGGER SIGNAL (softmax_top1: low = ambiguous/multi-bird, prompt crop) ===")
rows=[]
for img,d in data.items():
    rows.append((d["softmax_top1"], d["margin_1_2"], d["truth"], img))
rows.sort()
for st,mg,gt,img in rows:
    kind = "AMBIG/multi" if gt is None else "single bird"
    flag = "<-- would prompt crop" if st < 0.6 else ""
    print(f"  softmax_top1={st:5.3f} margin={mg:6.4f}  [{kind:11}] {img[:40]:40} {flag}")
