---
license: cc-by-nc-4.0
library_name: timm
pipeline_tag: image-feature-extraction
base_model: timm/vit_medium_patch16_clip_224.tinyclip_yfcc15m
base_model_relation: finetune
tags:
  - biology
  - birds
  - clip
  - knowledge-distillation
  - onnx
  - zero-shot-image-classification
---

# WingCLIP-0.3

A 38.7M-parameter bird image encoder for on-device identification, the third
step in a distillation chain that starts at
[BioCLIP-2](https://huggingface.co/imageomics/bioclip-2). It reaches **86.90
top-1 on NABirds** while being small enough to run in a browser tab.

It is the model behind [WingDex](https://github.com/jlian/wingdex).

## Lineage

Read this before comparing numbers: the model has a *teacher* and a
*grand-teacher*, and they are not the same thing.

| | model | visual params | NABirds top-1 |
|---|---|---|---|
| grand-teacher | [BioCLIP-2](https://huggingface.co/imageomics/bioclip-2), ViT-L/14 | 304.0M | 86.41 |
| teacher | [WingCLIP-0.1](https://huggingface.co/johnlian/WingCLIP-0.1), ViT-B-16 | 86.6M | **89.93** |
| **this model** | **WingCLIP-0.3, TinyCLIP-39M** | **38.7M** | **86.90** |

WingCLIP-0.1 was distilled from BioCLIP-2 and fine-tuned past it. WingCLIP-0.3
was then distilled from **WingCLIP-0.1**, not from BioCLIP-2.

So: this model **does not beat its teacher**. It retains 96.6% of WingCLIP-0.1's
NABirds accuracy at 45% of the parameters. It does edge out the grand-teacher
BioCLIP-2, at 7.9x fewer visual parameters, which is the more useful headline but
a comparison two steps removed from what it actually learned from.

**Read that BioCLIP-2 row narrowly.** Every number in the table above was
measured here on the 24,633-image NABirds *test* split. The BioCLIP-2 card
reports its own results over 555 categories and 48,640 images, so 86.41 is our
measurement of their model on our protocol, not their published figure. Two
further caveats: [BioCLIP 2.5](https://huggingface.co/imageomics/bioclip-2.5-vith14)
has since shipped a ViT-H/14 claiming +5.7% on species classification over
BioCLIP 2 and is untested here, and supervised fine-grained models trained
directly on NABirds score higher than any model in this table (93.2 for the
Token Injection Transformer, 92.4 for DBMFNet) with a fixed 555-class head
rather than zero-shot over 10,994 species.

This model is therefore **not** a claim to be the best open bird classifier.
The defensible claim is parameter efficiency: BioCLIP-2 accuracy at 13% of its
visual parameters, small enough to run in a browser tab.

### Why distil from the student rather than the original teacher

Both were tried, on a 401-species NABirds pilot:

| teacher | val_cos | NABirds top-1 |
|---|---|---|
| BioCLIP-2 | **0.9616** | 83.44 |
| WingCLIP-0.1 | 0.9612 | **89.09** |

BioCLIP-2 wins on embedding-copy fidelity and loses the task by 5.65 points. A
teacher already specialised to birds transfers better than a larger general
biology model, and `val_cos` will not tell you that.

## What it is

A visual tower whose output is projected into the 768-d BioCLIP-2 embedding
space and L2-normalized. `forward()` is the whole exportable graph: no text
encoder runs at inference time.

Classification is a cosine similarity against a frozen **10,994 x 768** matrix
of BioCLIP-2 text embeddings, shipped here as `text_classifier_fp32.npy`. So the
model covers 10,994 bird species even though only a subset had enough photos to
distil on. A species needs a *name* to be predictable, not training images.

The matrix held 11,167 rows until 173 species flagged extinct by eBird were
dropped from the taxonomy. Rows are keyed by position, so the published matrix
and `labels.json` are filtered together and stay row-aligned.

## Files

| file | what |
|---|---|
| `wingclip-0.3.pt` | the original training checkpoint, with `args` and the WiSE-FT metadata |
| `wingclip-0.3.safetensors` | the same weights, without the pickle |
| `wingclip-0.3-alpha.pt` | after distillation, before fine-tuning. val cosine 0.9436 |
| `wingclip-0.3-beta.pt` | after fine-tuning, before the WiSE-FT merge |
| `text_classifier_fp32.npy` | 10,994 x 768 frozen BioCLIP-2 text embeddings |
| `labels.json` | 10,994 rows of `[common name, scientific name, eBird code]`, in classifier row order |
| `onnx/wingclip_visual_fp32.onnx` | fp32 export, parity-checked against PyTorch |
| `onnx/wingclip_visual_int8.onnx` + `.data` | int8, 39 MB across two files, what WingDex ships to the web |

### Reconstructing the alpha sweep

The release is an exact linear interpolation of the two stages:

```python
released = (1 - a) * alpha + a * beta        # a = 0.60, verified to 0.0e+00
```

So `wingclip-0.3-alpha.pt` and `wingclip-0.3-beta.pt` regenerate any point on
the sweep. Measured NABirds top-1, for reference:

| a | 0.25 | 0.40 | 0.50 | **0.60** | 0.75 | 0.90 |
|---|---|---|---|---|---|---|
| top-1 | 86.27 | 86.64 | 86.82 | **86.90** | 86.90 | 86.56 |

0.60 and 0.75 tie; 0.60 ships. The optimum sits below WingCLIP-0.1's 0.90
because this fine-tune moves more of a smaller model.

## Usage

```python
import json
import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download
from PIL import Image
from timm.data import create_transform, resolve_data_config

REPO = "johnlian/WingCLIP-0.3"


class WingCLIP(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = timm.create_model(
            "vit_medium_patch16_clip_224.tinyclip_yfcc15m",
            pretrained=False, num_classes=0)
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


model = WingCLIP().eval()
ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu")
model.load_state_dict(ckpt["model"])

cfg = resolve_data_config({}, model=model.visual)
preprocess = create_transform(**cfg, is_training=False)

classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
labels = json.load(open(hf_hub_download(REPO, "labels.json")))

img = preprocess(Image.open("bird.jpg").convert("RGB")).unsqueeze(0)
with torch.no_grad():
    emb = model(img).numpy()

sims = (emb @ classifier.T)[0]
for i in sims.argsort()[-5:][::-1]:
    print(f"{sims[i]:.4f}  {labels[i][0]}  ({labels[i][1]})")
```

Preprocessing is standard CLIP: 224x224, bicubic, `crop_pct` 0.9, mean
`(0.48145466, 0.4578275, 0.40821073)`, std `(0.26862954, 0.26130258, 0.27577711)`.

The text embeddings were built with the prompt
`"a photo of {common name}, {scientific name}, a species of bird."`, so keep that
template if you rebuild the classifier.

## How it was trained

1. **Distil.** A TinyCLIP-39M visual tower regresses WingCLIP-0.1 embeddings over
   2,503,107 iNaturalist photos across 7,555 species, 25 epochs at lr 8.1e-5.
   Reaches val cosine 0.9436.
2. **Fine-tune.** 12 epochs of supervised fine-tuning on held-out ground-truth
   photos, lr 1e-5, weight decay 0.1, label smoothing 0.1, light augmentation.
3. **Merge.** WiSE-FT interpolation between the distilled and fine-tuned weights
   at **alpha = 0.60**, chosen by a sweep on NABirds.

Step 3 matters. The fine-tune alone trades away out-of-distribution accuracy;
the merge buys it back and then some.

## Quantization

Measured on all 24,633 NABirds images. `agree` is top-1 agreement with fp32.

| precision | top-1 | tower MB | cos(fp32) | agree |
|---|---|---|---|---|
| fp32 | 86.91 | 155 | 1.000000 | 100.00% |
| **int8** | **86.82** | **38.9** | 0.999923 | 99.27% |
| int4 block 32 | 84.61 | 21.9 | 0.988648 | 91.15% |
| int4 block 64 | 84.06 | 20.7 | 0.982274 | 88.99% |
| int4 block 128 | 81.50 | 20.1 | 0.974508 | 85.97% |

int8 is effectively free. int4 at block 128 is a *different* model rather than a
noisier one: 0.974 cosine and 86% agreement is a real behaviour change.

## Reranking with an occurrence prior

Raw zero-shot argmax is not the end of the story. WingDex reranks the top 25
candidates against an iNaturalist occurrence prior that is conditioned on both
the grid cell and the month:

```
score(species) = sim / T + beta * log P(species | cell, month)
```

On a 3,322-photo validation split, against a 97.14 recall ceiling:

| stage | top-1 |
|---|---|
| raw argmax, vision only | 81.10 |
| + occurrence prior, pooled over months | 93.80 |
| + month-aware prior (**what ships**) | **95.09** |

Month is worth a further +1.0 to +1.2 points, with a paired-bootstrap 95%
confidence interval of [+0.78, +1.60] over 2,000 resamples, so the interval
excludes zero. It matters because a species can be common in a cell in July and
absent in January, and a prior with no time dimension scores both the same.

The prior blob and the fitted `T`, `beta` and `k` live in the
[WingDex repo](https://github.com/jlian/wingdex), not here.

## Limitations

- **Birds only.** It has no notion of "not a bird". Feed it a dog and it returns
  a bird. Abstention has to be handled by the caller.
- **Low confidence means species ambiguity, not bad framing.** Top-1 confidence
  against relative bird area is Pearson 0.051. Cropping and retrying will not
  reliably rescue a low-confidence prediction.
- **North-American evaluation.** NABirds is the deciding benchmark, so accuracy
  outside North America is less well characterised.
- **Long tail.** Training covered the pre-drop taxonomy of 11,167 species, of
  which 7,555 were distilled and 3,850 were fine-tuned. The rest ride entirely
  on the text embedding of their name. The shipped matrix is now 10,994 rows,
  since 173 extinct species were dropped after training.
- **Two distillation steps from the original.** Errors in WingCLIP-0.1 are
  inherited, and there is no path back to BioCLIP-2's behaviour through this
  model.

## Licence and attribution

Weights are **CC BY-NC 4.0**. The WingDex source code is MIT, but the weights are
trained on iNaturalist photos of which 1,923,704 are CC-BY-NC, so non-commercial
propagates to the weights. WingDex is a strictly non-commercial project and this
model inherits that.

Training data: [iNaturalist Open Data](https://github.com/inaturalist/inaturalist-open-data).
2,503,107 images, 7,555 species, 62,423 credited observers. ShareAlike-licensed
photos were excluded. Per-photo attribution is recorded in `attributions.csv` in
the WingDex repo.

| licence | photos |
|---|---|
| CC-BY-NC | 1,923,704 |
| CC-BY | 389,106 |
| CC-BY-NC-ND | 126,460 |
| CC0 | 57,960 |
| CC-BY-ND | 5,877 |

Upstream model licences: [TinyCLIP-39M via timm](https://huggingface.co/timm/vit_medium_patch16_clip_224.tinyclip_yfcc15m)
(MIT) supplied the initial weights; [BioCLIP-2](https://huggingface.co/imageomics/bioclip-2)
(MIT) supplied the embedding space.

## Citation

WingCLIP has no paper of its own; cite the
[repository](https://github.com/jlian/wingdex) and the work below.

**TinyCLIP**, the backbone architecture and initial weights:

```bibtex
@inproceedings{wu2023tinyclip,
  title     = {{TinyCLIP}: CLIP Distillation via Affinity Mimicking and Weight Inheritance},
  author    = {Wu, Kan and Peng, Houwen and Zhou, Zhenghong and Xiao, Bin and Liu, Mengchen and Yuan, Lu and Xuan, Hong and Valenzuela, Michael and Chen, Xi and Wang, Xinggang and Chao, Hongyang and Hu, Han},
  booktitle = {Proceedings of the IEEE/CVF International Conference on Computer Vision (ICCV)},
  year      = {2023},
  eprint    = {2309.12314},
  archivePrefix = {arXiv}
}
```

**BioCLIP 2**, the grand-teacher and the source of the embedding space:

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
```

**BioCLIP**, which BioCLIP 2 builds on:

```bibtex
@inproceedings{stevens2024bioclip,
  title     = {{BioCLIP}: A Vision Foundation Model for the Tree of Life},
  author    = {Stevens, Samuel and Wu, Jiaman and Thompson, Matthew J and Campolongo, Elizabeth G and Song, Chan Hee and Carlyn, David Edward and Dong, Li and Dahdul, Wasila M and Stewart, Charles and Berger-Wolf, Tanya and Chao, Wei-Lun and Su, Yu},
  booktitle = {Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {19412--19424},
  year      = {2024}
}
```

**WiSE-FT**, the alpha-0.60 weight interpolation in step 3:

```bibtex
@inproceedings{wortsman2022robust,
  title     = {Robust fine-tuning of zero-shot models},
  author    = {Wortsman, Mitchell and Ilharco, Gabriel and Kim, Jong Wook and Li, Mike and Kornblith, Simon and Roelofs, Rebecca and Gontijo-Lopes, Raphael and Hajishirzi, Hannaneh and Farhadi, Ali and Namkoong, Hongseok and Schmidt, Ludwig},
  booktitle = {Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
  year      = {2022},
  eprint    = {2109.01903},
  archivePrefix = {arXiv}
}
```

**MobileCLIP2**, which supplied the distillation recipe bundle:

```bibtex
@article{faghri2025mobileclip2,
  title   = {{MobileCLIP2}: Improving Multi-Modal Reinforced Training},
  author  = {Faghri, Fartash and Vasu, Pavan Kumar Anasosalu and Koc, Cem and Shankar, Vaishaal and Toshev, Alexander and Tuzel, Oncel and Pouransari, Hadi},
  journal = {Transactions on Machine Learning Research},
  year    = {2025},
  eprint  = {2508.20691},
  archivePrefix = {arXiv}
}
```

**NABirds**, the evaluation dataset:

```bibtex
@inproceedings{vanhorn2015nabirds,
  title     = {Building a Bird Recognition App and Large Scale Dataset With Citizen Scientists: The Fine Print in Fine-Grained Dataset Collection},
  author    = {Van Horn, Grant and Branson, Steve and Farrell, Ryan and Haber, Scott and Barry, Jessie and Ipeirotis, Panos and Perona, Pietro and Belongie, Serge},
  booktitle = {Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {595--604},
  year      = {2015}
}
```

**CLIP** and **OpenCLIP**, the underlying method and the training library:

```bibtex
@inproceedings{radford2021clip,
  title     = {Learning Transferable Visual Models From Natural Language Supervision},
  author    = {Radford, Alec and Kim, Jong Wook and Hallacy, Chris and Ramesh, Aditya and Goh, Gabriel and Agarwal, Sandhini and Sastry, Girish and Askell, Amanda and Mishkin, Pamela and Clark, Jack and Krueger, Gretchen and Sutskever, Ilya},
  booktitle = {Proceedings of the 38th International Conference on Machine Learning (ICML)},
  year      = {2021},
  eprint    = {2103.00020},
  archivePrefix = {arXiv}
}

@software{ilharco2021openclip,
  title  = {OpenCLIP},
  author = {Ilharco, Gabriel and Wortsman, Mitchell and Wightman, Ross and Gordon, Cade and Carlini, Nicholas and Taori, Rohan and Dave, Achal and Shankar, Vaishaal and Namkoong, Hongseok and Miller, John and Hajishirzi, Hannaneh and Farhadi, Ali and Schmidt, Ludwig},
  year   = {2021},
  doi    = {10.5281/zenodo.5143773}
}
```
