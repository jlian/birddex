#!/usr/bin/env python3
"""Phase 4: evaluate a distilled student vs the BioCLIP-2 teacher.

The student is trained INTO the teacher's 768-d embedding space, so both are
scored with the SAME text-classifier matrix (BioCLIP-2 taxonomic prompts). This
isolates "how much teacher accuracy did the student retain" - the core distill
question - with zero pipeline differences between them.

No GPT here (per decision 2026-07-22): this is a pure encoder-vs-encoder
comparison on labeled anchors. GPT lives in the separate gated+range pipeline
experiment, not this harness.

Metrics per model (student, teacher):
  - top-1 / top-5 species accuracy
  - retention = student_acc / teacher_acc
  - confidence-gated accuracy + abstention rate (softmax over sims, threshold
    sweep): the calibrated-abstention lever, does the student stay accurate when
    allowed to say "not sure"?

Usage:
  python eval_student.py --checkpoint runs/pilot500_vitb/last.pt \
      --eval-set nabirds --limit 5000
  python eval_student.py --checkpoint ... --eval-set fixtures   # the 27 golden imgs
"""
import argparse
import glob
import json
import os
import time

import numpy as np
import torch
import torch.nn.functional as F
import open_clip
from PIL import Image


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


TEACHER = "hf-hub:imageomics/bioclip-2"


def build_text_classifier(taxonomy, device, batch=512):
    """BioCLIP-2 text-embedding matrix over the taxonomy (the shared classifier).

    taxonomy: list of [common, scientific, ...] rows.
    Returns (text_feats [N,768] normalized, commons list).
    """
    commons = [r[0] for r in taxonomy]
    scis = [r[1] for r in taxonomy]
    model, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    model = model.to(device).eval()

    def prompt(c, s):
        return f"a photo of {c}, {s}, a species of bird."

    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            b = [prompt(commons[j], scis[j]) for j in range(i, min(i + batch, len(commons)))]
            tf = model.encode_text(tok(b).to(device))
            tf = tf / tf.norm(dim=-1, keepdim=True)
            feats.append(tf.float().cpu())
    text_feats = torch.cat(feats).to(device)
    log(f"text classifier: {tuple(text_feats.shape)} over {len(commons)} species")
    # return the teacher model too (reused as the teacher image encoder)
    return text_feats, commons, model


def load_student(checkpoint, device):
    """Rebuild the Student from a train_student.py checkpoint."""
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from train_student import Student
    ckpt = torch.load(checkpoint, map_location="cpu")
    args = ckpt.get("args", {})
    arch = args.get("arch", "ViT-B-16")
    pretrained = args.get("pretrained", "laion2b_s34b_b88k")
    st = Student(arch, pretrained)
    st.load_state_dict(ckpt["model"])
    st = st.to(device).eval()
    log(f"student: {arch} @ epoch {ckpt.get('epoch','?')} "
        f"(train val_cos_sim={ckpt.get('val_cos_sim','?')})")
    return st, st.preprocess


@torch.no_grad()
def embed_teacher(model, x):
    f = model.encode_image(x)
    return F.normalize(f.float(), dim=-1)


@torch.no_grad()
def embed_student(st, x):
    return st(x)  # already normalized in Student.forward


def score(embeds, text_feats, labels, commons, tag):
    """Compute top-1/top-5 + confidence-gated metrics. embeds: [N,768] on device."""
    sims = embeds @ text_feats.T                     # [N, S]
    probs = (sims * 100).softmax(-1)                 # calibrated-ish confidence
    top5 = sims.topk(5, dim=-1).indices.cpu().numpy()
    conf = probs.max(-1).values.cpu().numpy()
    top1 = top5[:, 0]
    lab = np.array(labels)
    ok1 = top1 == lab
    ok5 = (top5 == lab[:, None]).any(1)
    n = len(lab)
    out = {
        "model": tag, "n": n,
        "top1": round(100 * ok1.mean(), 2),
        "top5": round(100 * ok5.mean(), 2),
    }
    # abstention sweep: if conf < thr -> abstain; report accuracy on kept + coverage
    gated = []
    for thr in [0.0, 0.3, 0.5, 0.7, 0.9]:
        keep = conf >= thr
        cov = keep.mean()
        acc = ok1[keep].mean() if keep.any() else 0.0
        gated.append({"thr": thr, "coverage": round(100 * cov, 1),
                      "acc_on_kept": round(100 * acc, 2)})
    out["abstention"] = gated
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--eval-set", default="fixtures",
                    help="fixtures | a dir of <label>/<img> | an index json")
    ap.add_argument("--images", default="images")
    ap.add_argument("--truth", default="truth.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default="eval_results.json")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if dev == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    taxo = json.load(open(args.taxonomy))
    common_to_idx = {r[0].lower(): i for i, r in enumerate(taxo)}

    text_feats, commons, teacher = build_text_classifier(taxo, dev)
    student, student_pp = load_student(args.checkpoint, dev)
    _, _, teacher_pp = open_clip.create_model_and_transforms(TEACHER)

    # ---- assemble the eval image list + integer labels ----
    samples = []  # (path, label_idx)
    if args.eval_set == "fixtures":
        truth = json.load(open(args.truth))
        for path in sorted(glob.glob(os.path.join(args.images, "*"))):
            fn = os.path.basename(path)
            gt = truth.get(fn)
            if gt and gt.lower() in common_to_idx:
                samples.append((path, common_to_idx[gt.lower()]))
    else:
        # generic: a directory laid out as <eval_set>/<species_common>/<img>
        for d in sorted(glob.glob(os.path.join(args.eval_set, "*"))):
            if not os.path.isdir(d):
                continue
            sp = os.path.basename(d).replace("_", " ").lower()
            if sp not in common_to_idx:
                continue
            for path in glob.glob(os.path.join(d, "*")):
                samples.append((path, common_to_idx[sp]))
    if args.limit:
        samples = samples[:args.limit]
    log(f"eval samples: {len(samples)}")
    if not samples:
        raise SystemExit("no eval samples matched the taxonomy; check --eval-set/labels")

    # ---- embed with both models ----
    def run(model_pp, embed_fn, tag):
        pp = model_pp
        embs, labs = [], []
        buf, blab = [], []
        for path, lab in samples:
            try:
                x = pp(Image.open(path).convert("RGB"))
            except Exception:
                continue
            buf.append(x); blab.append(lab)
            if len(buf) == args.batch:
                embs.append(embed_fn(torch.stack(buf).to(dev)).cpu())
                labs += blab; buf, blab = [], []
        if buf:
            embs.append(embed_fn(torch.stack(buf).to(dev)).cpu())
            labs += blab
        E = torch.cat(embs).to(dev)
        return score(E, text_feats, labs, commons, tag)

    log("scoring teacher (BioCLIP-2)...")
    r_teacher = run(teacher_pp, lambda x: embed_teacher(teacher, x), "bioclip-2-teacher")
    log("scoring student...")
    r_student = run(student_pp, lambda x: embed_student(student, x), "student")

    retention1 = round(100 * r_student["top1"] / max(1e-9, r_teacher["top1"]), 1)
    retention5 = round(100 * r_student["top5"] / max(1e-9, r_teacher["top5"]), 1)
    report = {
        "checkpoint": args.checkpoint, "eval_set": args.eval_set,
        "teacher": r_teacher, "student": r_student,
        "retention_top1_pct": retention1, "retention_top5_pct": retention5,
    }
    json.dump(report, open(args.out, "w"), indent=2)
    print("\n" + "=" * 64, flush=True)
    print(f"EVAL  ({r_teacher['n']} images)", flush=True)
    print(f"  teacher top1/top5: {r_teacher['top1']}/{r_teacher['top5']}", flush=True)
    print(f"  student top1/top5: {r_student['top1']}/{r_student['top5']}", flush=True)
    print(f"  retention:         top1 {retention1}%  top5 {retention5}%", flush=True)
    print("  student abstention (conf thr -> coverage%, acc-on-kept%):", flush=True)
    for g in r_student["abstention"]:
        print(f"    thr {g['thr']}: cov {g['coverage']}%  acc {g['acc_on_kept']}%", flush=True)
    print(f"\nwrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
