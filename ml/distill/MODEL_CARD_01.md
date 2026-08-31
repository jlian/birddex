---
license: cc-by-nc-4.0
library_name: open_clip
pipeline_tag: image-feature-extraction
base_model: laion/CLIP-ViT-B-16-laion2B-s34B-b88K
base_model_relation: finetune
new_version: johnlian/WingCLIP-0.3
tags:
  - biology
  - birds
  - clip
  - knowledge-distillation
  - zero-shot-image-classification
---

# WingCLIP-0.1

An 86.6M-parameter bird image encoder distilled from
[BioCLIP-2](https://huggingface.co/imageomics/bioclip-2) and then fine-tuned
past it. **89.93 top-1 on NABirds** against the teacher's 86.41, at 3.5x fewer
visual parameters.

It is the most accurate model in the [WingDex](https://github.com/jlian/wingdex)
family. It is **not** the one WingDex ships: at 346 MB fp32 it does not fit the
25 MB-per-file web budget, so the app runs
[WingCLIP-0.3](https://huggingface.co/johnlian/WingCLIP-0.3) instead.

WingCLIP-0.1's other job is to be **the teacher of WingCLIP-0.3**. You need this
model to reproduce 0.3.

## Lineage

| | model | visual params | NABirds top-1 |
|---|---|---|---|
| teacher | BioCLIP-2, ViT-L/14 | 304.0M | 86.41 |
| **this model** | **WingCLIP-0.1, ViT-B-16** | **86.6M** | **89.93** |
| student | WingCLIP-0.3, TinyCLIP-39M | 38.7M | 86.90 |

### How a student beats its teacher

Distillation alone cannot exceed the teacher, because the teacher's embedding
*is* the regression target. The distill stage lands at 81.83, well short of
86.41. The gain comes from the next stage: a supervised fine-tune on
ground-truth bird photos, which adds label information BioCLIP-2 never saw.
Retention above 100% is the expected outcome of that, not an anomaly.

## What it is

A ViT-B-16 visual tower whose output is projected into the 768-d BioCLIP-2
embedding space and L2-normalized. `forward()` is the whole exportable graph: no
text encoder runs at inference time.

Classification is a cosine similarity against a frozen **11,015 x 768** matrix
of BioCLIP-2 text embeddings, shipped here as `text_classifier_fp32.npy`. It is
byte-identical to the one in the 0.3 repo; both models target the same space.

The matrix held 11,167 rows until 152 species with IUCN status EX or EW were
dropped from the taxonomy. Rows are keyed by position, so the published matrix
and `labels.json` are filtered together and stay row-aligned.

## Files

| file | what |
|---|---|
| `wingclip-0.1.pt` | the released checkpoint, WiSE-FT alpha 0.90 |
| `wingclip-0.1.safetensors` | the same weights, without the pickle |
| `wingclip-0.1-alpha.pt` | after distillation, before fine-tuning. NABirds 81.83 |
| `wingclip-0.1-beta.pt` | after fine-tuning, before the WiSE-FT merge |
| `text_classifier_fp32.npy` | 11,015 x 768 frozen BioCLIP-2 text embeddings |
| `labels.json` | 11,015 rows of `[common name, scientific name, eBird code]`, in classifier row order |

No ONNX here. 0.1 is not deployed anywhere, and the exports on hand predate the
released checkpoint by enough that I could not confirm they came from it. Use
`export_onnx.py` in the WingDex repo if you need one.

### Reconstructing the alpha sweep

The release is an exact linear interpolation of the two stages:

```python
released = (1 - a) * alpha + a * beta        # a = 0.90, verified to 0.0e+00
```

So `wingclip-0.1-alpha.pt` and `wingclip-0.1-beta.pt` regenerate any point on
the sweep. Measured NABirds top-1, for reference:

| a | 0.25 | 0.50 | 0.75 | **0.90** | 1.00 |
|---|---|---|---|---|---|
| top-1 | 85.86 | 88.42 | 89.69 | **89.93** | 89.77 |

## Usage

```python
import json
import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download
from PIL import Image

REPO = "johnlian/WingCLIP-0.1"


class WingCLIP01(torch.nn.Module):
    def __init__(self):
        super().__init__()
        model, _, self.preprocess = open_clip.create_model_and_transforms(
            "ViT-B-16", pretrained=None)
        self.visual = model.visual
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


model = WingCLIP01().eval()
ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.1.pt"), map_location="cpu")
model.load_state_dict(ckpt["model"])

classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
labels = json.load(open(hf_hub_download(REPO, "labels.json")))

img = model.preprocess(Image.open("bird.jpg").convert("RGB")).unsqueeze(0)
with torch.no_grad():
    emb = model(img).numpy()

sims = (emb @ classifier.T)[0]
for i in sims.argsort()[-5:][::-1]:
    print(f"{sims[i]:.4f}  {labels[i][0]}  ({labels[i][1]})")
```

Preprocessing is standard CLIP at 224x224: mean
`(0.48145466, 0.4578275, 0.40821073)`, std `(0.26862954, 0.26130258, 0.27577711)`.

The text embeddings were built with the prompt
`"a photo of {common name}, {scientific name}, a species of bird."`, so keep that
template if you rebuild the classifier.

## How it was trained

1. **Distil.** A LAION ViT-B-16 visual tower regresses BioCLIP-2 embeddings over
   2,503,107 iNaturalist photos across 7,555 species, 20 epochs at lr 1e-4.
   val cosine 0.9650, NABirds 81.83.
2. **Fine-tune.** 12 epochs of supervised fine-tuning on ground-truth photos,
   lr 1e-5. In-distribution GT-val 77.61.
3. **Merge.** WiSE-FT interpolation at **alpha = 0.90**, giving NABirds 89.93.

The optimum sits at 0.90 where the WiSE-FT paper finds roughly 0.5, because this
fine-tune is gentle: it moves about 4.7% of the weights, mostly the projection
and the last blocks. WingCLIP-0.3's stronger fine-tune moves its optimum down to
0.60.

## Quantization

NABirds, all 24,633 images.

| variant | ~MB | top-1 | delta |
|---|---|---|---|
| fp32 | 346 | 89.94 | - |
| fp16 | 173 | 89.94 | +0.00 |
| int8 | 87 | 89.89 | -0.05 |
| int4 block 128 | 43 | 89.06 | -0.88 |
| int3 block 128 | 32 | 0.00 | collapse |

int3 does not degrade, it fails outright.

## Limitations

- **Too large for the web.** 87 MB at int8 against a 25 MB-per-file cap is why
  WingCLIP-0.3 exists.
- **Birds only.** No notion of "not a bird". Feed it a dog and it returns a bird.
- **Low confidence means species ambiguity, not bad framing.** Top-1 confidence
  against relative bird area is Pearson 0.051.
- **North-American evaluation.** NABirds is the deciding benchmark, so accuracy
  elsewhere is less well characterised.
- **Long tail.** Training covered the pre-drop taxonomy of 11,167 species, of
  which 7,555 were distilled on. The rest ride entirely on the text embedding of
  their name. The shipped matrix is now 11,015 rows, since 152 extinct species
  were dropped after training.

## Licence and attribution

Weights are **CC BY-NC 4.0**. The WingDex source code is MIT, but the weights are
trained on iNaturalist photos of which 1,923,704 are CC-BY-NC, so non-commercial
propagates to the weights.

Training data: [iNaturalist Open Data](https://github.com/inaturalist/inaturalist-open-data).
2,503,107 images, 7,555 species, 62,423 credited observers. ShareAlike-licensed
photos were excluded.

Upstream: [LAION CLIP ViT-B-16](https://huggingface.co/laion/CLIP-ViT-B-16-laion2B-s34B-b88K)
supplied the initial weights; [BioCLIP-2](https://huggingface.co/imageomics/bioclip-2)
(MIT) was the teacher and supplies the embedding space.

## Citation

WingCLIP has no paper of its own; cite the
[repository](https://github.com/jlian/wingdex) and the work below. The full
bibliography is on the
[WingCLIP-0.3 card](https://huggingface.co/johnlian/WingCLIP-0.3#citation); the
two that matter most here are BioCLIP 2 and WiSE-FT.

```bibtex
@inproceedings{gu2025bioclip2,
  title     = {{BioCLIP} 2: Emergent Properties from Scaling Hierarchical Contrastive Learning},
  author    = {Gu, Jianyang and Stevens, Sam and Campolongo, Elizabeth and Thompson, Matthew and Zhang, Net and Wu, Jiaman and Kopanev, Andrei and Mai, Zheda and White, Alexander and Balhoff, James and Dahdul, Wasila and Rubenstein, Daniel and Lapp, Hilmar and Berger-Wolf, Tanya and Chao, Wei-Lun and Su, Yu},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {38},
  pages     = {102778--102811},
  year      = {2025},
  eprint    = {2505.23883},
  archivePrefix = {arXiv}
}

@inproceedings{wortsman2022robust,
  title     = {Robust fine-tuning of zero-shot models},
  author    = {Wortsman, Mitchell and Ilharco, Gabriel and Kim, Jong Wook and Li, Mike and Kornblith, Simon and Roelofs, Rebecca and Gontijo-Lopes, Raphael and Hajishirzi, Hannaneh and Farhadi, Ali and Namkoong, Hongseok and Schmidt, Ludwig},
  booktitle = {Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
  year      = {2022},
  eprint    = {2109.01903},
  archivePrefix = {arXiv}
}
```
