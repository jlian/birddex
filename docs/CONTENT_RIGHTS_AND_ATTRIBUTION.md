# Content Rights and Attribution Worksheet

Use this ledger for App Review's content-rights question and for release audits. Repository references document implemented attribution; they do not replace the source terms.

| Source | WingDex use | Implemented attribution or license evidence | Submission status |
|---|---|---|---|
| WingCLIP model | On-device bird image encoder | Project model documentation identifies WingCLIP-0.3 and its BioCLIP-2/TinyCLIP lineage; model artifacts ship locally | **Confirm** final model-card licenses and redistribution rights |
| iNaturalist Open Data | Distillation photos and geographic occurrence prior | Identification UI credits iNaturalist occurrence data; model documentation records open-data training source | **Confirm** corpus manifest contains only accepted photo licenses and all required notices |
| Wikimedia Commons / Wikipedia | Species reference images and descriptions | Species views show the creator and license inline; identification reference photos link the caption to the Commons file page, which CC 4.0 3(a)(2) accepts as attribution "by providing a URI or hyperlink to a resource that includes the required information" | **Confirm** every displayed asset either names its creator or links to the file page that does |
| eBird / Cornell Lab | Taxonomy names/codes and user CSV interoperability | Settings and documentation identify eBird import/export; no claim of eBird endorsement | **Confirm** taxonomy redistribution and trademark wording against current eBird terms |
| BirdLife International | Optional outbound links to species factsheets | No BirdLife content or data ships, so no attribution is carried; the privacy policy and terms name BirdLife as a linked third party | Ready, subject to confirmation that linking alone carries no further obligation |
| OpenStreetMap (ODbL 1.0) | Local reverse geocoding archive | Web and iOS show a linked `(c) OpenStreetMap contributors, ODbL 1.0` caption below the location control; the route returns the same string | Ready |
| Geoapify | Explicit place search only | Web and iOS show a linked `Search by Geoapify` caption below the location control; privacy policy identifies Geoapify; WingDex does not cache provider responses | Ready |
| WingDex app source and original design | Application code, copy, and original assets | Repository is MIT-licensed | Ready, subject to owner confirmation of authorship |

## Release checks

- [ ] Review the final app's Settings, outing review, species detail, and identification screens for visible attribution.
- [ ] Verify attribution remains visible at accessibility text sizes and in dark mode.
- [ ] Preserve third-party notices required by the final model and data artifacts in the distributed app or linked legal page.
- [ ] Record the exact model, taxonomy, occurrence-prior, and source-data versions used by the submitted build.
- [ ] Obtain owner confirmation that WingDex remains within every non-commercial restriction relied upon by the model/data pipeline.