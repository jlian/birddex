"""Push ONLY the corrected model card to huggingface.co/johnlian/WingCLIP-0.3.

The card claimed reranking ends at 93.80, which is the pooled occurrence prior.
The shipping pipeline also conditions on month and reaches 95.09, so the card
understated the model and printed a formula that is not the one in use.

Uploads a single file rather than the folder: the weights on the hub are
already correct and re-uploading them would be pointless traffic.
"""
import os
import sys

CARD = "/home/jlian/wingdex/ml/distill/MODEL_CARD.md"
REPO_ID = "johnlian/WingCLIP-0.3"

with open(CARD, encoding="utf-8") as f:
    body = f.read()

if "cell, month" not in body:
    sys.exit("card does not contain the month correction, refusing to upload")
if "95.09" not in body:
    sys.exit("card is missing the 95.09 figure, refusing to upload")

print("card looks corrected: %d bytes" % len(body))

from huggingface_hub import HfApi

api = HfApi()
info = api.upload_file(
    path_or_fileobj=CARD,
    path_in_repo="README.md",
    repo_id=REPO_ID,
    repo_type="model",
    commit_message="docs: reranking uses a month-aware prior and reaches 95.09",
    commit_description=(
        "The card stopped at the pooled occurrence prior (93.80) and printed "
        "P(species | cell). The shipping pipeline conditions on cell AND month "
        "and reaches 95.09 top-1 on the same 3,322-photo validation split. "
        "Month is worth +1.0 to +1.2 points, bootstrap 95% CI [+0.78, +1.60]."
    ),
)
print("uploaded: %s" % info)
