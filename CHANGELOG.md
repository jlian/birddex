## [1.22.3](https://github.com/jlian/wingdex/compare/v1.22.2...v1.22.3) (2026-08-03)


### Bug Fixes

* address review feedback on hero blur and image loading ([153f717](https://github.com/jlian/wingdex/commit/153f717752aa42ea770fbb415db78d5bd5697908))

## [1.22.2](https://github.com/jlian/wingdex/compare/v1.22.1...v1.22.2) (2026-08-03)


### Performance Improvements

* **WingDex:** derive hero image URL from the dex thumbnail ([03b8ce5](https://github.com/jlian/wingdex/commit/03b8ce528e357068e6d1172f0fe282a7f222a8d8)), closes [#272](https://github.com/jlian/wingdex/issues/272)

## [1.22.1](https://github.com/jlian/wingdex/compare/v1.22.0...v1.22.1) (2026-07-23)


### Bug Fixes

* **ios:** harden generated Xcode configuration ([a5ba94b](https://github.com/jlian/wingdex/commit/a5ba94b158010347a6c008bb5f407277e23af83c))

# [1.22.0](https://github.com/jlian/wingdex/compare/v1.21.2...v1.22.0) (2026-07-21)


### Bug Fixes

* **Data:** make persistence retries safe ([6528f94](https://github.com/jlian/wingdex/commit/6528f94dd5e5164be87101813a0edf47870b7594))
* **dev:** harden workspace app monitor ([f5f079f](https://github.com/jlian/wingdex/commit/f5f079fa3ebf295bd6f52688a36b53d4cb92737e))
* **Observability:** sanitize logs and propagate traces ([49e0c35](https://github.com/jlian/wingdex/commit/49e0c359279f0086417596086faae54156ba71da))


### Features

* **Outings:** complete iOS detail editing parity ([40ebaf8](https://github.com/jlian/wingdex/commit/40ebaf8b953f0630df43464bf39d668c74e9225e))
* **WingDex:** add lifer celebrations and haptics ([ab7f7e9](https://github.com/jlian/wingdex/commit/ab7f7e9840ae16580532b6a1b9f0a97f02b18e0c))
* **WingDex:** enrich species detail and add family sort ([b5eb777](https://github.com/jlian/wingdex/commit/b5eb777419672a94828e93be59167069350c3b0f))

## [1.21.2](https://github.com/jlian/wingdex/compare/v1.21.1...v1.21.2) (2026-07-21)


### Bug Fixes

* **range:** scan full 3x3 neighbor ring for range priors ([#258](https://github.com/jlian/wingdex/issues/258)) ([c26f19a](https://github.com/jlian/wingdex/commit/c26f19a097f02bec058b29bf7991de781e3989f4))

## [1.21.1](https://github.com/jlian/wingdex/compare/v1.21.0...v1.21.1) (2026-04-20)


### Bug Fixes

* Settings page UX, location search, and error handling improvements ([#219](https://github.com/jlian/wingdex/issues/219), [#234](https://github.com/jlian/wingdex/issues/234)) ([18b8b82](https://github.com/jlian/wingdex/commit/18b8b826a579706ad6af75485ae1731f9c263143))

# [1.21.0](https://github.com/jlian/wingdex/compare/v1.20.0...v1.21.0) (2026-04-19)


### Features

* **Observability:** structured logging, W3C trace context, error handling ([#251](https://github.com/jlian/wingdex/issues/251)) ([2a8e6a8](https://github.com/jlian/wingdex/commit/2a8e6a8c4e0c27ddc034cc38bf8aeecd0d8c6a4b))
* **Workers:** migrate from Cloudflare Pages to Workers ([98b137a](https://github.com/jlian/wingdex/commit/98b137a038b0df55cde2fc614ff07ad44fb51de6)), closes [#186](https://github.com/jlian/wingdex/issues/186)

# [1.20.0](https://github.com/jlian/wingdex/compare/v1.19.2...v1.20.0) (2026-04-17)


### Features

* **SpeciesDetails:** add species factsheet links to BirdLife from AviList DataZone IDs ([#244](https://github.com/jlian/wingdex/issues/244)) ([3cf270e](https://github.com/jlian/wingdex/commit/3cf270e497d4389a7492047bd2b3f8a5b1bf7781))


### Performance Improvements

* **Dev:** use remote R2 binding and persist local state outside workspace ([#245](https://github.com/jlian/wingdex/issues/245)) ([da50835](https://github.com/jlian/wingdex/commit/da5083502c455c3e09afb6a71bfdd50ec6300342)), closes [#244](https://github.com/jlian/wingdex/issues/244)

## [1.19.2](https://github.com/jlian/wingdex/compare/v1.19.1...v1.19.2) (2026-04-17)


### Performance Improvements

* **BirdID, RangeFilter:** off-main-thread photo decoding, soften out-of-range penalty ([#243](https://github.com/jlian/wingdex/issues/243)) ([4699b50](https://github.com/jlian/wingdex/commit/4699b50be2c2ddd1bcbfa31b409c7e1b794f364a)), closes [#242](https://github.com/jlian/wingdex/issues/242)

## [1.19.1](https://github.com/jlian/wingdex/compare/v1.19.0...v1.19.1) (2026-03-24)


### Bug Fixes

* duplicate photo placeholder, wiki gallery filter, outings sort label ([848ffe5](https://github.com/jlian/wingdex/commit/848ffe53adfc5bf150af9313b1afa8b7e3f93669)), closes [#235](https://github.com/jlian/wingdex/issues/235) [#236](https://github.com/jlian/wingdex/issues/236) [#237](https://github.com/jlian/wingdex/issues/237) [#235](https://github.com/jlian/wingdex/issues/235) [#236](https://github.com/jlian/wingdex/issues/236) [#237](https://github.com/jlian/wingdex/issues/237)
* **iOS.Wikimedia:** gallery parity with web - URL fix, plumage, attribution, swipe ([726e08c](https://github.com/jlian/wingdex/commit/726e08c7375115ba30a9570a1c7742ace727694b))
* **PrivacyPage, TermsPage:** update last updated date and add BirdLife International reference ([f03c3e2](https://github.com/jlian/wingdex/commit/f03c3e271e1f42975946221b0f36e2a0d1c929ac))
* **Release:** checkout branch tip to avoid stale-SHA after queued release ([8a72195](https://github.com/jlian/wingdex/commit/8a721952e0731d2ef2fd8be6ca85a6a2f1c14d40))
* **Web.Wikimedia:** smarter gallery filtering with plumage parsing and dedup ([c6adf1e](https://github.com/jlian/wingdex/commit/c6adf1eef05e8d1908525e7e5b7f137af89b81b6))
* **Web.Wikimedia:** update section comment to reflect Commons source ([1541fbe](https://github.com/jlian/wingdex/commit/1541fbebedfb7dd4720d49e909b40c9ba0a535df))
* **Wikimedia:** address PR review - safety, memoization, dead code ([6fe7c90](https://github.com/jlian/wingdex/commit/6fe7c9016866bf4f5a1b59d46eb9b897c41ac3c9))
* **Wikimedia:** plumage matching, attribution, and review fixes ([3eecdb7](https://github.com/jlian/wingdex/commit/3eecdb7aef340383672667cf1dac78cfd0cb4975))
* **Wikimedia:** rename prop, remove dead code, fix indentation ([315797d](https://github.com/jlian/wingdex/commit/315797ddd77fa43e44deb6d7ab286b579106d1ac))
* **Wikimedia:** update JSDoc and fix attribution indentation ([8877efb](https://github.com/jlian/wingdex/commit/8877efbe4e19916c42ffddc8fb7db57e92e1bca9))

# [1.19.0](https://github.com/jlian/wingdex/compare/v1.18.0...v1.19.0) (2026-03-22)


### Bug Fixes

* **Auth:** show session-expired toast, fix iOS dupe photo hang ([0310a42](https://github.com/jlian/wingdex/commit/0310a4204f18fdebb07040194b13aacc2b73cb54))
* **BirdId:** address PR [#232](https://github.com/jlian/wingdex/issues/232) review comments ([504c3d1](https://github.com/jlian/wingdex/commit/504c3d1670d91b397078c55a1c8a33beae889d89))
* **BirdId:** address PR [#232](https://github.com/jlian/wingdex/issues/232) review round 2 ([83d3a26](https://github.com/jlian/wingdex/commit/83d3a267ae1113d520bc46029a5b00cd5e9e0c45))
* **BirdId:** address PR review - signout ref, openapi 3.1, unused imports ([0e478d5](https://github.com/jlian/wingdex/commit/0e478d563fccdc84d7a6073e71172c59c8c19993))
* **BirdId:** address PR review round - session toast, selection reset, cache limit ([ed6ec21](https://github.com/jlian/wingdex/commit/ed6ec21bde8fed49e11767fb92c22caff175db54))
* **BirdId:** clarify test multiplier comment, tighten plumage enum in OpenAPI ([5e513b1](https://github.com/jlian/wingdex/commit/5e513b1725b622ea634717c9c57909839fc45d2a))
* **BirdId:** prevent duplicate species in candidates ([32ac48a](https://github.com/jlian/wingdex/commit/32ac48a3c70a0931b54b33f5ee0fb5b4810911db))
* **BirdId:** update candidate count requirements in bird identification instructions ([96a3693](https://github.com/jlian/wingdex/commit/96a3693204473a8ad2cc381423bd67661d27451d))
* **Gallery:** cap gallery cache, fix arrow comment, clean up Card line ([89013fb](https://github.com/jlian/wingdex/commit/89013fb7588abf71dcce1a1197476cd239d4dcb4))
* **Gallery:** respect prefers-reduced-motion, show arrows on focus-visible ([0294174](https://github.com/jlian/wingdex/commit/02941743dcc821b400684f89495bffa2b78dd911))
* **Release:** serialize web and iOS release workflows to prevent git push race ([#233](https://github.com/jlian/wingdex/issues/233)) ([29dfdb3](https://github.com/jlian/wingdex/commit/29dfdb347b27b373510224bf9e81b4955845f4f4))
* **Tests:** use unknown birdSize value to test default fallback ([61b0915](https://github.com/jlian/wingdex/commit/61b0915300e43fed7208e1bb44e56fabdd25cded))


### Features

* **BirdId:** add tiny birdSize for auto-crop decision ([9826e8e](https://github.com/jlian/wingdex/commit/9826e8e93f49b76d6055751d3df34cce5f764b40))
* **BirdId:** migrate from Chat Completions to Responses API ([0b1f036](https://github.com/jlian/wingdex/commit/0b1f036533d21aa50dca55685f36c739edcc9072))
* **BirdId:** optimize prompt for gpt-5.4-mini with XML sections and example ([b31c9ff](https://github.com/jlian/wingdex/commit/b31c9ff8dd4efdfe3d80dae40faec76ead8e9b29))
* **BirdID:** swipeable Wikipedia reference gallery during identification ([b8af3c2](https://github.com/jlian/wingdex/commit/b8af3c2641aacfbbdfcd3352b8ca79c7a51ea7c1))
* **Gallery:** improve Wikipedia reference gallery on web and iOS ([32628f0](https://github.com/jlian/wingdex/commit/32628f045370880ad31ea4f65fa9bc5ff6ec7191))
* **RangeFilter:** add BirdLife-to-eBird taxonomy crosswalk via AviList ([456497b](https://github.com/jlian/wingdex/commit/456497b409c7c28a688e0277a527bb245adc2479))
* **RangeFilter:** overhaul BirdLife data to 11-byte format with tiered adjustment ([4ac8f5a](https://github.com/jlian/wingdex/commit/4ac8f5a39ee1328a03403e72bb3508124de64639))
* **RangePriors:** location-based range filtering with BirdLife data ([#230](https://github.com/jlian/wingdex/issues/230)) ([6e2e1ef](https://github.com/jlian/wingdex/commit/6e2e1ef9f9125d9a9d20e6fe556a89cfee5eb036)), closes [#225](https://github.com/jlian/wingdex/issues/225)

# [1.18.0](https://github.com/jlian/wingdex/compare/v1.17.3...v1.18.0) (2026-03-16)


### Bug Fixes

* **BirdId:** drop AI candidates with no taxonomy match ([cd36202](https://github.com/jlian/wingdex/commit/cd36202b8e8af1f13d9548b7a878d6f7a9da1743))
* **BirdId:** use flatMap instead of map+filter for type-safe candidate filtering ([3e3fa5a](https://github.com/jlian/wingdex/commit/3e3fa5ad9554f54d1237711afe96f0c9bb63031f))
* **ci:** replace GNU timeout with portable loop for macOS runner ([82fd145](https://github.com/jlian/wingdex/commit/82fd145760eeb782c00a35e8e951fe38cc2d527d))
* **Deps:** resolve @tailwindcss/vite peer dep conflict for Vite 8 ([573f8a5](https://github.com/jlian/wingdex/commit/573f8a5ca678e1ca2958b0b2bb440afeb20bccee))
* **Dex:** include possible observations in dex computation ([69e5976](https://github.com/jlian/wingdex/commit/69e5976b8a11a9f4f79ff57407acd1ddcd9600da))
* **Import:** expand timezone list and fix place search coordinates ([c276c7c](https://github.com/jlian/wingdex/commit/c276c7ca6f8b3f5b12accbb2981a4a9c418e5923))
* **iOS:** address PR review feedback ([df32a7e](https://github.com/jlian/wingdex/commit/df32a7eacc2f1bc6035be1f01a12cde4b68a7558))
* **iOS:** auto-process camera photos after capture ([0767d24](https://github.com/jlian/wingdex/commit/0767d240823c86294f78906c03c2d9ae6b052cb4))
* **iOS:** fix crop lag and orientation mismatch ([cf99f35](https://github.com/jlian/wingdex/commit/cf99f35e03bb6429934cd8643e200c600a3f105c))
* **iOS:** fix CropView renderer scale, disable apply while loading, check API in CI health ([cc1e1ed](https://github.com/jlian/wingdex/commit/cc1e1ed2683971580a738f63539e4f2aa38ece12))
* **iOS:** fix place search race condition and improve location UX ([c5b7615](https://github.com/jlian/wingdex/commit/c5b7615219a0d6b70e781caf77931e0b205ea0bd))
* **iOS:** hide confirm/possible buttons when no species identified ([7d3150b](https://github.com/jlian/wingdex/commit/7d3150b3d6028c6d681e4aff649701e2f3c22108))
* **iOS:** keep pbxproj version in sync with project.yml ([4a108f5](https://github.com/jlian/wingdex/commit/4a108f5a26f876b161e4de0647e4ff84fe95bf83))
* **iOS:** match row heights between WingDex and Outings lists ([d223cf9](https://github.com/jlian/wingdex/commit/d223cf986deeaff7a1622d0224d542db28f7370e))
* **iOS:** remove xcodegen error suppression, use npm run dev in CI ([b8b5528](https://github.com/jlian/wingdex/commit/b8b5528c862157a0ee3fc06911ac3ddbeb28aeef))
* **iOS:** use afterFirstUnlock keychain accessibility for sessions ([29f718e](https://github.com/jlian/wingdex/commit/29f718e002462dc6b3f31d869aa9123be073e8c7))
* **Web:** remove old bird icon from boot shell ([a62dd1b](https://github.com/jlian/wingdex/commit/a62dd1b4662a31198103a2006a9444694167c4cd))


### Features

* **Auth:** iOS passkey sign-up, session fixes, and test coverage ([9924415](https://github.com/jlian/wingdex/commit/9924415ee3a0bc5512c10625e4632a4f9a1a01d6))
* **iOS:** show git branch/commit in settings, add FunNames tests ([04a3eb0](https://github.com/jlian/wingdex/commit/04a3eb066520d56888e88d28a31ecc29fb52f162))

## [1.17.3](https://github.com/jlian/wingdex/compare/v1.17.2...v1.17.3) (2026-03-13)


### Bug Fixes

* **ci:** fix iOS release git asset paths relative to ios/ working dir ([629a2b5](https://github.com/jlian/wingdex/commit/629a2b5978cdd38a3e73c29d8338dd34b2f1d383))
* **ci:** reset ios/package.json version to 0.1.0 ([8285f3c](https://github.com/jlian/wingdex/commit/8285f3c616ef5d195d2f34e9fda16bbf224cf9b6))

## [1.17.2](https://github.com/jlian/wingdex/compare/v1.17.1...v1.17.2) (2026-03-10)


### Bug Fixes

* **ci:** scope iOS releases to ios/ path, exclude ios/ from web releases ([10013f9](https://github.com/jlian/wingdex/commit/10013f901aec616800ef8d990f0e54758979745e))

## [1.17.1](https://github.com/jlian/wingdex/compare/v1.17.0...v1.17.1) (2026-03-10)


### Bug Fixes

* **ci:** hide root .releaserc.json during iOS semantic-release run ([037d5f3](https://github.com/jlian/wingdex/commit/037d5f3c0c001297c9737643e9eaee7dadfdb908))

# [1.17.0](https://github.com/jlian/wingdex/compare/v1.16.0...v1.17.0) (2026-03-10)


### Bug Fixes

* **AddPhotos:** align iOS flow with web crop and review behavior ([f301265](https://github.com/jlian/wingdex/commit/f3012654b1ed16b562e21b40b87952304d0b5f7a))
* **AddPhotos:** bug bash polish - untinted glass, auto-start, real tab, GPS toggle to settings ([a86ed38](https://github.com/jlian/wingdex/commit/a86ed387e5b48ff35eb5bca9aa6facbb823bebf6))
* **AddPhotos:** FK constraint error, crop UX, progress bar, layout bugs ([367144b](https://github.com/jlian/wingdex/commit/367144b3c9b1bcf2b0f3586f6bffff2834bb6c96))
* **AddPhotos:** restore liquid glass bottom toolbar for per-photo confirm ([d72872f](https://github.com/jlian/wingdex/commit/d72872f65464280be1dc78d82d496ab90de9ab44))
* **AppIcon:** adjust eye color ([eebee1f](https://github.com/jlian/wingdex/commit/eebee1f85e8c6aa4ff6563f7385fbf3d617362ad))
* **Auth:** address PR review comments ([60c157e](https://github.com/jlian/wingdex/commit/60c157edc59f4505124558538591650456668b2c))
* **Auth:** restore hosted social oauth callback handling ([7b62830](https://github.com/jlian/wingdex/commit/7b62830c49d650ca1d762d4c4a46cd3824ebfd82))
* **ci:** remove broken quoting in xcodebuild authenticationKeyPath ([8463997](https://github.com/jlian/wingdex/commit/846399784bb379bf15c340608be0b99e468ffdf7))
* **CropView:** center crop square on device, tighter default zoom ([4e58fdf](https://github.com/jlian/wingdex/commit/4e58fdfa643c56bd5a9c5f58d163d382a2d1ea07))
* **iOS,Settings:** address review - actor isolation and stale comment ([844da7f](https://github.com/jlian/wingdex/commit/844da7f24df463001564e21a54748e6345a5ae54))
* **iOS:** add @MainActor isolation to AuthService for data-race safety ([6f9214e](https://github.com/jlian/wingdex/commit/6f9214e05fd3b1c46d74172ee904c56cc0a41c20))
* **iOS:** address second round of PR review comments ([3cd1e72](https://github.com/jlian/wingdex/commit/3cd1e72e2b4537f0975e6085b48c1ca9467852ca))
* **iOS:** adjust tinted icon shade and toolbar spacing ([0a66060](https://github.com/jlian/wingdex/commit/0a6606084f10a9dca2ecf9bdbe6680d936a5c865))
* **iOS:** cancel stale wiki image fetches on rapid species selection ([952bbce](https://github.com/jlian/wingdex/commit/952bbcea35d0338a340ee271ce25c92d76817787))
* **iOS:** fix Swift build errors from review fixes ([9371729](https://github.com/jlian/wingdex/commit/9371729c622f567366096f9681c139afebb7ff82))
* **iOS:** fix test target plist and cookie leakage in integration tests ([5f1b065](https://github.com/jlian/wingdex/commit/5f1b065cdb4d443709b22245037ecc93f2f7255e))
* **iOS:** reset per-cluster state in OutingReviewView ([8dac126](https://github.com/jlian/wingdex/commit/8dac126a9d783280a52eb55ad2acd4b7c030eca9))
* **iOS:** use safe cast for UIWindowScene presentation anchors ([a2dc47d](https://github.com/jlian/wingdex/commit/a2dc47dc736983ebeccb1487a41878956fd13257))
* **Previews:** resolve all species thumbnails from bundled taxonomy.json ([20b95d8](https://github.com/jlian/wingdex/commit/20b95d87805cb66a4262b1ec28061ed80e32632d))
* **SignIn:** stabilize layout to prevent jank from loading/error states ([55d25dd](https://github.com/jlian/wingdex/commit/55d25ddd1d07ddea91553112956a6e88e76fd4b0))


### Features

* **AddPhotos:** rework flow with per-photo confirm, outing review, two-tier AI ([0105074](https://github.com/jlian/wingdex/commit/01050741bb60728e33900a990b2f65824149214a))
* **agents:** add Code Review custom agent for static analysis ([38660de](https://github.com/jlian/wingdex/commit/38660de08c73d5a2f7d7414a898117536550c124))
* **CropView:** Photos-app-style crop with glass chrome and dynamic photo backdrop ([b733526](https://github.com/jlian/wingdex/commit/b73352641884ae7117ac37361e41112da7fa87ec))
* **Previews:** add realistic demo data to all SwiftUI previews ([634a283](https://github.com/jlian/wingdex/commit/634a28395ae65e8a6f6a347a918254ae58c1ebe2)), closes [#Preview](https://github.com/jlian/wingdex/issues/Preview) [#Preview](https://github.com/jlian/wingdex/issues/Preview)
* **Settings:** implement Phase 4 - Settings & Profile Parity ([400f0d3](https://github.com/jlian/wingdex/commit/400f0d3a7aeb3ee748bbe2bd3dbf0b0305e1396e))

# [1.16.0](https://github.com/jlian/wingdex/compare/v1.15.1...v1.16.0) (2026-03-08)


### Bug Fixes

* **Auth:** add appBundleIdentifier for native Apple Sign-In ([536f85e](https://github.com/jlian/wingdex/commit/536f85e14696dcda7f5907963c50840278f7b032))
* **Auth:** inject both cookie name variants for bearer token auth ([5aed505](https://github.com/jlian/wingdex/commit/5aed505ec2b92b07bfd13326f3a27d339d59f9f8))
* **Auth:** use encodeURIComponent instead of URLSearchParams in mobile callback ([d0b3e15](https://github.com/jlian/wingdex/commit/d0b3e15da6f720add643bd249307b4f769104dea))
* **iOS:** add confirmation dialog before loading demo data ([d2f7403](https://github.com/jlian/wingdex/commit/d2f740329e309cbb80c76661f0447a1a0aef5880))
* **iOS:** adjust dark mode colors to match web oklch palette ([fe702a8](https://github.com/jlian/wingdex/commit/fe702a87225447838f24640de044787d06d854df))
* **iOS:** auto-generate passkey device label, add passkey debug logging ([14dda36](https://github.com/jlian/wingdex/commit/14dda367cdb908716214291e8fb2984c42763381))
* **iOS:** avatar glass follows avatar shape via .interactive() ([1152de0](https://github.com/jlian/wingdex/commit/1152de0c43c4e9877053914b54804efd4617c30c))
* **iOS:** avatar rightmost in toolbar, sort to its left ([423acda](https://github.com/jlian/wingdex/commit/423acda13feacac1f3168502d9d6c5849281f2b5))
* **iOS:** config, fonts, context menus, log out, confirmations ([14099a5](https://github.com/jlian/wingdex/commit/14099a576066c21abd229d336696f1ea2d3f0723))
* **iOS:** demo data loading, detached add button, plain avatar ([c7a3d68](https://github.com/jlian/wingdex/commit/c7a3d6862bff8cb3098b564ea83343a0413f4d12))
* **iOS:** ensure signed token is captured before passkey registration ([1b3cd35](https://github.com/jlian/wingdex/commit/1b3cd35d32983c4e730c38644cff8920dfbcae5e))
* **iOS:** exact oklch dark mode colors, circle avatar shape ([7c40cae](https://github.com/jlian/wingdex/commit/7c40cae70fcc4df8a1804082033cad209c8a68ff))
* **iOS:** fix 401 after sign-in, use TabSection for add button ([1506ab6](https://github.com/jlian/wingdex/commit/1506ab640c343a3bd6fb75d8b25b9b9c7be48be6))
* **iOS:** fix passkey sign-in showing guest account ([21bb930](https://github.com/jlian/wingdex/commit/21bb9309af42530cceba2b0318e23ec9631967a6))
* **iOS:** fix UIWindow deprecation warnings and improve sign-in error handling ([fb60d8e](https://github.com/jlian/wingdex/commit/fb60d8eb553bb422be26f9d169203f19542be728))
* **iOS:** flat avatar overlay, sort buttons moved to leading ([d08f2a2](https://github.com/jlian/wingdex/commit/d08f2a28093bb4c1bdd1af92d1c6737c10133648))
* **iOS:** inline titles, separate toolbar items with glass ([d874b8a](https://github.com/jlian/wingdex/commit/d874b8a739c166276dd19919e6fba2ea8fc8fb66))
* **iOS:** large left-justified titles, grouped sort+avatar toolbar ([fb50d80](https://github.com/jlian/wingdex/commit/fb50d800b65029f67e1c349bdd7150383808ca75))
* **iOS:** move 'species observed' to right of count on Home ([4450b0a](https://github.com/jlian/wingdex/commit/4450b0aa8ed83ec6b4f381c4c584b09cf9fad8d9))
* **iOS:** move avatar back to toolbar, sort button to its left ([8ee3bda](https://github.com/jlian/wingdex/commit/8ee3bdaf9b136be6078c0974f282bd101b09f6e2))
* **iOS:** move avatar to overlay, fix emoji in preview ([301db9d](https://github.com/jlian/wingdex/commit/301db9df547ebfced65758da8bb4baaedae86aef))
* **iOS:** persist userImage, camera icon, fix AddPhotosFlow for tab ([4dc1653](https://github.com/jlian/wingdex/commit/4dc1653653d6d25ceea81781b014713b7c8cb683))
* **iOS:** Phase 3.5 polish - avatar, scroll, add button, demo ([699603d](https://github.com/jlian/wingdex/commit/699603d81d9c299c4b6ee405c28f1cf30ef55a64))
* **iOS:** remove Group wrapper from all views, proper List pattern ([f57323a](https://github.com/jlian/wingdex/commit/f57323a7347ba320105b1d3433fca99dccfea80e))
* **iOS:** remove log out confirmation, add dev domain for passkeys ([9d6ed64](https://github.com/jlian/wingdex/commit/9d6ed6425b2d1dd2be9dc9260fc583d7682731a3))
* **iOS:** remove navigationSurface to fix search bar flash ([3a1e3da](https://github.com/jlian/wingdex/commit/3a1e3da080a7b4366295755dc7e3e16b104cebb2))
* **iOS:** rename 'Sign-in failed' error to 'Log in failed' ([b6f6380](https://github.com/jlian/wingdex/commit/b6f638017b367bf58ab9553829414ce6f2a593eb))
* **iOS:** restore .background(Color.pageBg) on List views ([9f53447](https://github.com/jlian/wingdex/commit/9f534478fc44da79c2b0abb0940d0eda971d9095))
* **iOS:** revert options step to Bearer-only, keep cookies for verify only ([b41f986](https://github.com/jlian/wingdex/commit/b41f986b1af13bd2b9ab34882f9019db50600d69))
* **iOS:** send session cookie alongside Bearer for passkey endpoints ([cd629ae](https://github.com/jlian/wingdex/commit/cd629ae05667507d9d508e4afc32f075cbf95c1e))
* **iOS:** store signed session token for passkey cookie auth ([415e40e](https://github.com/jlian/wingdex/commit/415e40e6200344e890a1138f3e66aebba475ac3f))
* **iOS:** use bundled taxonomy for eBird URLs ([0461e1a](https://github.com/jlian/wingdex/commit/0461e1a41312476370b87a770b3cd7e43b4c0562))
* **iOS:** use cookie-only auth for passkey registration (no Bearer) ([1233ee2](https://github.com/jlian/wingdex/commit/1233ee2823fc34d7615f47d31a6906fc141cdb95))
* **iOS:** use session cookies on passkey options step too ([ee82265](https://github.com/jlian/wingdex/commit/ee82265f2ac94aba81db1b55523d551bffa632c1))
* **iOS:** warnings, inline titles, circle glass, list separators ([4f1c08b](https://github.com/jlian/wingdex/commit/4f1c08b78d2d839c0888516e13d0c1ef2d208986))
* **iOS:** wrap context menu previews in NavigationStack ([7d0ca03](https://github.com/jlian/wingdex/commit/7d0ca03575a798f57f21082004c5116884fb1451))
* **test:** use set-auth-token header and fresh context for Bearer auth tests ([a122079](https://github.com/jlian/wingdex/commit/a1220795fa4cbf6d0a97fa4297821f1612e21c05))
* **Web:** align species detail headers, remove All About Birds ([c49df49](https://github.com/jlian/wingdex/commit/c49df49c82969cfc6859aac7dca83943cb471536))


### Features

* **Auth:** migrate to Better Auth bearer plugin, remove cookie translation hack ([3abd975](https://github.com/jlian/wingdex/commit/3abd9751ea0b52f9aca3d2cbe59dabeadfd28c66))
* **iOS:** add associated domain for dev passkey testing ([4b0387a](https://github.com/jlian/wingdex/commit/4b0387af294f56d3fe60f3541b90eb97c066b7c2))
* **iOS:** add context menus to detail view rows ([598d1c4](https://github.com/jlian/wingdex/commit/598d1c432dc0a953d9d435cdc49bbc33da4854bd))
* **iOS:** add Continue with Google sign-in button ([b145b27](https://github.com/jlian/wingdex/commit/b145b27da99bd7234bbef70a594fcad388c3940f))
* **iOS:** add View Species/View Outing to context menus ([51c474b](https://github.com/jlian/wingdex/commit/51c474b162d451366caba1815eea8f93fee4ffc7))
* **iOS:** home chevrons, peek-pop previews, context menus ([1010769](https://github.com/jlian/wingdex/commit/1010769c6784700613a98d228814ef8e7b3df527))
* **iOS:** Phase 3.5 - navigation rework and SignInView update ([7f1bd3f](https://github.com/jlian/wingdex/commit/7f1bd3f14e24ed277fdb5fd222440bde3af28122))
* **iOS:** Phase 3.5.3 - empty state fix, context menus, plan update ([dba9703](https://github.com/jlian/wingdex/commit/dba9703cac830de9404c83ec7654cc9786998095))
* **iOS:** Phase 3.6 - dark mode support ([f62a97b](https://github.com/jlian/wingdex/commit/f62a97b99d97d3d5e08f6d87468cfd088a640598))
* **iOS:** replace Phosphor bird icons with custom SF Symbols ([d887d47](https://github.com/jlian/wingdex/commit/d887d47ec4bc1a6aa6c0d4a8aaf553a2786586bd))
* **iOS:** tap outing map to open Apple Maps ([ea279ea](https://github.com/jlian/wingdex/commit/ea279ea3fca409cd4b34763ad18c096304d06d70))

## [1.15.1](https://github.com/jlian/wingdex/compare/v1.15.0...v1.15.1) (2026-03-07)


### Bug Fixes

* **Icons:** revert nav header logo to duotone variant ([9df82c5](https://github.com/jlian/wingdex/commit/9df82c5ce21ee4e0650359f9a4dd33a9cf25d490))

# [1.15.0](https://github.com/jlian/wingdex/compare/v1.14.1...v1.15.0) (2026-03-07)


### Bug Fixes

* **Icons:** use correct paths and gradients for color BirdLogo variants ([325e636](https://github.com/jlian/wingdex/commit/325e636657b368c511ea6dc02563f9e13da12b24))


### Features

* **Icons:** add color and color-dark gradient variants to BirdLogo ([55a6ab6](https://github.com/jlian/wingdex/commit/55a6ab600d9f4a72e959f354f13f4fed811f17d4))

## [1.14.1](https://github.com/jlian/wingdex/compare/v1.14.0...v1.14.1) (2026-03-07)


### Bug Fixes

* **Icons:** use circle shape for favicon ([3cb6bea](https://github.com/jlian/wingdex/commit/3cb6bea49da791a04fe16f7f452ad552b11a6b9e))

# [1.14.0](https://github.com/jlian/wingdex/compare/v1.13.0...v1.14.0) (2026-03-07)


### Features

* **Icons:** regenerate PWA PNGs and favicon with new branding ([4050a2a](https://github.com/jlian/wingdex/commit/4050a2a6e03c2cf1e76ca8bbaba2b0662407c8b7)), closes [#12391b](https://github.com/jlian/wingdex/issues/12391b)

# [1.13.0](https://github.com/jlian/wingdex/compare/v1.12.1...v1.13.0) (2026-03-07)


### Bug Fixes

* **Auth:** unify auth modal login and signup ([d5a4ad1](https://github.com/jlian/wingdex/commit/d5a4ad1b2b3a0137bd2471cee010289122c2d133))
* **Auth:** update e2e helper for combined passkey signup flow ([50be5a6](https://github.com/jlian/wingdex/commit/50be5a643d3641953bf71d990f0e679fd6e64944))
* **Icon:** add app icon ([3d4f883](https://github.com/jlian/wingdex/commit/3d4f883e25190f84d28d383f14fa11f7603e227a))
* **iOS:** add localhost webcredentials for simulator passkey support ([473fb0a](https://github.com/jlian/wingdex/commit/473fb0ae24fc86f99a7ee323fd081b655b5eb3a9))
* **iOS:** convert HomeView to List, remove ScrollRowButtonStyle dead code ([c2d3da4](https://github.com/jlian/wingdex/commit/c2d3da4121f6164eca7b301ea7b16d876af27d2c))
* **iOS:** enable edge-to-edge layout and match web styling precisely ([3a5f240](https://github.com/jlian/wingdex/commit/3a5f24063feee4b91516a629a7af15ae2fbf7460))
* **iOS:** extract signed session token from Set-Cookie, add demo data loading ([fef03fc](https://github.com/jlian/wingdex/commit/fef03fc68f0efe16a633df143ee52670a4569e40))
* **iOS:** fix auth flow and match web app styling ([8fe445a](https://github.com/jlian/wingdex/commit/8fe445a257f9f52e7a37f106b9a9cd6d4dbab477)), closes [#2B6B4F](https://github.com/jlian/wingdex/issues/2B6B4F) [#3D9B6E](https://github.com/jlian/wingdex/issues/3D9B6E)
* **iOS:** GitHub OAuth origin header, signed token callback, date parsing, debug logging ([89676c3](https://github.com/jlian/wingdex/commit/89676c3b73ddff483c8d83c3a6d0ea170c4adf07))
* **iOS:** major UI polish pass matching web app styling ([71c0af4](https://github.com/jlian/wingdex/commit/71c0af4c8d12df6819bbafc51463d05e20b21916))
* **iOS:** make all sign-in buttons visually consistent ([7ff0fc7](https://github.com/jlian/wingdex/commit/7ff0fc73d60e95d93ed616a3c7f912ff58d62fe1))
* **iOS:** native List for detail pages, consistent dividers and highlights ([ec56cd0](https://github.com/jlian/wingdex/commit/ec56cd0608ba4e27453f55bd6b73d6b4a14d1e76))
* **iOS:** polish empty states and settings view ([bb8f234](https://github.com/jlian/wingdex/commit/bb8f234a8db1f13aee57f7ae647b561b72d39d9c))
* **iOS:** polish list rows to match web app's Messages/Mail-style layout ([fb087d3](https://github.com/jlian/wingdex/commit/fb087d3be05e16e51f49e84b10f2da530ce9d683))
* **iOS:** resolve all 16 Xcode deprecation warnings for iOS 26 ([d930fa2](https://github.com/jlian/wingdex/commit/d930fa290ce975531b7aff07b62362c975a1650a))
* **iOS:** scope cell override to plain lists, fix Settings Form appearance ([dd7d97f](https://github.com/jlian/wingdex/commit/dd7d97feda0900b2bc4c02d30304717376d9ef86))
* **iOS:** switch to List for native press highlights, fix hero crop ([f6e26a2](https://github.com/jlian/wingdex/commit/f6e26a27975d39cd39f756f821eded2b488c7d57))
* **iOS:** target iOS 26 and use macos-16 CI runner ([6cd0df7](https://github.com/jlian/wingdex/commit/6cd0df710deefc1f0baa216a777ad6b1a0de120f))
* **iOS:** use macos-26 runner label (not macos-16) ([458a551](https://github.com/jlian/wingdex/commit/458a5517b3d885c6cf76282cd2912ebe65914fce))
* **iOS:** visual polish to match web app styling ([2db6ace](https://github.com/jlian/wingdex/commit/2db6acedac0ffd9643a2edbb4dafbf502411ed47))
* **iOS:** wire up AI crop suggestion with paddedSquareCrop, fix drag tracking ([8d7a2bf](https://github.com/jlian/wingdex/commit/8d7a2bf06a9ae650862d9e1431e8d50cc0e9c8fe))
* **PR:** address review comments and iOS CI build failure ([8f52f83](https://github.com/jlian/wingdex/commit/8f52f83749aa6d158d832c146af84651a393805c))


### Features

* **API:** add OpenAPI 3.1 spec for all endpoints ([ed1526b](https://github.com/jlian/wingdex/commit/ed1526b421df23544b3c51df4fe32ed4fcc96b4d))
* **Auth:** add Google sign-in and polish auth entry ([fa95acc](https://github.com/jlian/wingdex/commit/fa95accd99b0fdbd62d3242cb3be5f0b7eb49bc1))
* **Auth:** implement bearer token auth for iOS via session token bridge ([4c30227](https://github.com/jlian/wingdex/commit/4c3022798cd0e5867795df1d57ed9266e2b4aab1))
* **Auth:** implement native Apple Sign-In via ASAuthorizationAppleIDProvider ([6fac920](https://github.com/jlian/wingdex/commit/6fac920e4b500459ab16b02a411d1f8f93a75239))
* **Auth:** implement passkey sign-in, registration, and management ([0a5041c](https://github.com/jlian/wingdex/commit/0a5041ce23a3ae236691302a6e2367fa733a9fd9))
* **Icons:** monochrome circle favicon with filled bird silhouette ([40868d8](https://github.com/jlian/wingdex/commit/40868d8e9b731e678cf5fa685e050cc9eb813cc5))
* **Icons:** replace Phosphor Bird with custom BirdLogo glyph ([8375a20](https://github.com/jlian/wingdex/commit/8375a20aa549402cd3c72ccbadda9fc2d9a34258))
* **iOS:** add os_log debugging and anonymous sign-in for local dev ([f16c302](https://github.com/jlian/wingdex/commit/f16c3020fe14b06d608a06714407e0c29673ca26))
* **iOS:** auth mode toggle, tab icon fix, and anonymous sign-in cookie fix ([9951a28](https://github.com/jlian/wingdex/commit/9951a2868243e60a625e097c256e7f523a5af3cd))
* **iOS:** implement Add Photos flow (Phase 3) ([4a64c3d](https://github.com/jlian/wingdex/commit/4a64c3d5c434ba12ebe99cd9349b37fed666861e))
* **iOS:** implement Phase 2 core data views ([185ae23](https://github.com/jlian/wingdex/commit/185ae238c5c073336394d852925dce46ef57c15b))
* **iOS:** larger species cards, Apple Music style 2.25 per row ([4fa3acb](https://github.com/jlian/wingdex/commit/4fa3acb003deb5e9e65f4b2666b4c98bccd72620))
* **iOS:** match web app warm color palette and fullscreen layout ([889ca6e](https://github.com/jlian/wingdex/commit/889ca6e8e4918eebd824a8430547da011e9136d3))
* **iOS:** scaffold Xcode project with stub views, services, and CI ([b11049c](https://github.com/jlian/wingdex/commit/b11049cc747958c2d644e9eb49e544e2522365c3)), closes [#Preview](https://github.com/jlian/wingdex/issues/Preview)
* **iOS:** shared bird logo, tab reorder, and home empty state ([27a46c8](https://github.com/jlian/wingdex/commit/27a46c8386793e67ba140291dfdf428ae5a5f50e))
* **iOS:** square species cards, mini maps, List perf, consistent highlights ([e7c6e2e](https://github.com/jlian/wingdex/commit/e7c6e2e336cb155ed8fdf7e9947c01f8a6801f03))
* **iOS:** target iOS 26 with liquid glass, modern Tab API, and HIG design principles ([ce8e7ad](https://github.com/jlian/wingdex/commit/ce8e7add53de82ead6e3a64603ef5a53cd363cdb))

## [1.12.1](https://github.com/jlian/wingdex/compare/v1.12.0...v1.12.1) (2026-03-07)


### Bug Fixes

* **LegalLinks:** expose crawlable Privacy and Terms links for OAuth branding verification ([#217](https://github.com/jlian/wingdex/issues/217)) ([1968362](https://github.com/jlian/wingdex/commit/1968362784090df6d8d0acf86399c12a0b5740ec))

# [1.12.0](https://github.com/jlian/wingdex/compare/v1.11.6...v1.12.0) (2026-03-05)


### Features

* **Home:** species cards with gradient text overlay, white/90 hero text ([248fa63](https://github.com/jlian/wingdex/commit/248fa63d2834364a5f3d1c1cbd65bfaa3208113d))

## [1.11.6](https://github.com/jlian/wingdex/compare/v1.11.5...v1.11.6) (2026-03-04)


### Bug Fixes

* **UploadWizard:** support drag-and-drop file upload with visual feedback ([#210](https://github.com/jlian/wingdex/issues/210)) ([6c41b09](https://github.com/jlian/wingdex/commit/6c41b09c29122fa7389dc486be4553f3765d3a54)), closes [#209](https://github.com/jlian/wingdex/issues/209)

## [1.11.5](https://github.com/jlian/wingdex/compare/v1.11.4...v1.11.5) (2026-02-27)


### Bug Fixes

* **Tests:** accept 24h locale format and extend ARM e2e timeout ([20db032](https://github.com/jlian/wingdex/commit/20db0329c30553603ea0169b6c59c254ab1d152f))

## [1.11.4](https://github.com/jlian/wingdex/compare/v1.11.3...v1.11.4) (2026-02-25)


### Bug Fixes

* **Thumbnails:** restore iOS eager-load to prevent swipe-back flicker ([765d8f4](https://github.com/jlian/wingdex/commit/765d8f419acfea1845ff9b72e43557f70f910bcf))

## [1.11.3](https://github.com/jlian/wingdex/compare/v1.11.2...v1.11.3) (2026-02-25)


### Bug Fixes

* **WingDex:** simplify hero to always-blurred base with overlay fade-in ([cdc30af](https://github.com/jlian/wingdex/commit/cdc30afdf46256347c591073edf0251395153eb8))

## [1.11.2](https://github.com/jlian/wingdex/compare/v1.11.1...v1.11.2) (2026-02-25)


### Bug Fixes

* **Navigation:** use fixed header to prevent iOS Safari flash on scroll-to-top ([ca999c5](https://github.com/jlian/wingdex/commit/ca999c588dd2c2f6a76b4d7b6a4decfa9e9870d9))
* **Tabs:** match iOS touch-press to desktop pressed state ([a9a986e](https://github.com/jlian/wingdex/commit/a9a986e305493e62e35dae4f21516b33a593f068))

## [1.11.1](https://github.com/jlian/wingdex/compare/v1.11.0...v1.11.1) (2026-02-25)


### Bug Fixes

* **WingDex:** keep blurred base visible when full-res hero image fails ([e86bf3e](https://github.com/jlian/wingdex/commit/e86bf3e8b15c500e0245570059b73bc1e21d9e62))
* **WingDex:** keep detail hero blur stable while summary resolves ([db8a1d9](https://github.com/jlian/wingdex/commit/db8a1d9b0c33bd1421902b42ac710efec7e947db))
* **WingDex:** smooth detail hero blur-to-clear transition ([03f30a1](https://github.com/jlian/wingdex/commit/03f30a1d40551473e5deffc62f129359c0c93b46))

# [1.11.0](https://github.com/jlian/wingdex/compare/v1.10.2...v1.11.0) (2026-02-25)


### Bug Fixes

* **Thumbnails:** remove iOS eager-load hack and preserve wiki fields in dex rebuild ([5eff144](https://github.com/jlian/wingdex/commit/5eff1440ac9c93ca181437ebf2e458a963193f67))


### Features

* **Vite:** support LAN dev server via env vars ([64d2c9a](https://github.com/jlian/wingdex/commit/64d2c9a2830c2fb2f2c2f0a33ef21a2fe4301c86))


### Performance Improvements

* **Thumbnails:** use batched MediaWiki pageimages API for thumbnail URLs ([cf9c341](https://github.com/jlian/wingdex/commit/cf9c3417709461a699039272c331c4bbc205e4b6))

## [1.10.2](https://github.com/jlian/wingdex/compare/v1.10.1...v1.10.2) (2026-02-25)


### Bug Fixes

* rename workflow input to images_only (hyphens break dot notation) ([ae01acf](https://github.com/jlian/wingdex/commit/ae01acf16c40dd89977d4d0f6f567e098ff26076))

## [1.10.1](https://github.com/jlian/wingdex/compare/v1.10.0...v1.10.1) (2026-02-25)


### Bug Fixes

* raise base throttle to 400ms to avoid 429 oscillation ([1094204](https://github.com/jlian/wingdex/commit/10942040a0ecdf9edd2d2554e4b4622e890b78d0))

# [1.10.0](https://github.com/jlian/wingdex/compare/v1.9.5...v1.10.0) (2026-02-25)


### Features

* **UX:** icon sort buttons, family sort, upload summary, Capital Case, icon flash fix ([#202](https://github.com/jlian/wingdex/issues/202)) ([f318d7a](https://github.com/jlian/wingdex/commit/f318d7a434c3a8ca29eb438bf1cf36b927cf995a)), closes [#199](https://github.com/jlian/wingdex/issues/199) [#193](https://github.com/jlian/wingdex/issues/193) [#192](https://github.com/jlian/wingdex/issues/192) [#69](https://github.com/jlian/wingdex/issues/69) [#194](https://github.com/jlian/wingdex/issues/194) [#199](https://github.com/jlian/wingdex/issues/199) [#69](https://github.com/jlian/wingdex/issues/69) [#194](https://github.com/jlian/wingdex/issues/194) [#193](https://github.com/jlian/wingdex/issues/193) [#192](https://github.com/jlian/wingdex/issues/192) [#199](https://github.com/jlian/wingdex/issues/199) [#195](https://github.com/jlian/wingdex/issues/195) [#194](https://github.com/jlian/wingdex/issues/194) [#193](https://github.com/jlian/wingdex/issues/193) [#192](https://github.com/jlian/wingdex/issues/192) [#69](https://github.com/jlian/wingdex/issues/69)

## [1.9.5](https://github.com/jlian/wingdex/compare/v1.9.4...v1.9.5) (2026-02-25)


### Bug Fixes

* address review - allow lookup fallback in BirdRow, avoid payload bloat in dex API ([a4413a9](https://github.com/jlian/wingdex/commit/a4413a984451975725d541024f17eab21249aff8))


### Performance Improvements

* inline wiki metadata and remove list-view lookup fanout ([d6c851c](https://github.com/jlian/wingdex/commit/d6c851c6b6bf47a6e6d078208ab4bcb9757f76e4))

## [1.9.4](https://github.com/jlian/wingdex/compare/v1.9.3...v1.9.4) (2026-02-25)


### Bug Fixes

* remove service worker to fix dev HMR and stale cache issues ([f1510b6](https://github.com/jlian/wingdex/commit/f1510b694b2808bba98687c048ba8ce4651dbb67))

## [1.9.3](https://github.com/jlian/wingdex/compare/v1.9.2...v1.9.3) (2026-02-25)


### Bug Fixes

* **dev:** skip service worker in dev to prevent HMR WebSocket errors ([1c1af79](https://github.com/jlian/wingdex/commit/1c1af797f151ed92b43f3b4f22c04ee7ee16f907))

## [1.9.2](https://github.com/jlian/wingdex/compare/v1.9.1...v1.9.2) (2026-02-24)


### Bug Fixes

* **dev:** prevent orphaned wrangler/esbuild processes ([a661e30](https://github.com/jlian/wingdex/commit/a661e3017d2746a8cad3fe551e20d35d31a58029))

## [1.9.1](https://github.com/jlian/wingdex/compare/v1.9.0...v1.9.1) (2026-02-24)


### Bug Fixes

* simplify PWA manifest setup and add service worker ([#200](https://github.com/jlian/wingdex/issues/200)) ([98eef83](https://github.com/jlian/wingdex/commit/98eef8341b1e193f4009b4d6f6626b346425ee74))

# [1.9.0](https://github.com/jlian/wingdex/compare/v1.8.0...v1.9.0) (2026-02-24)


### Bug Fixes

* **ios:** reduce WingDex swipe-back thumbnail flashing ([063a16c](https://github.com/jlian/wingdex/commit/063a16cdf373074eeaf36fc2608db1c63d235057))
* normalize hover conflicts with press-feel utilities ([b363139](https://github.com/jlian/wingdex/commit/b3631391c3212f4daa87aa20cd7acaf3bd9714da))


### Features

* add iOS-style press-feel CSS utilities and touch-press handler ([1eacb0d](https://github.com/jlian/wingdex/commit/1eacb0d262c541f6853212b83ac373b49c305f8b))

# [1.8.0](https://github.com/jlian/wingdex/compare/v1.7.2...v1.8.0) (2026-02-24)


### Bug Fixes

* align API create responses with persisted columns ([72451b2](https://github.com/jlian/wingdex/commit/72451b25bbb08cf78d912249046c85a5a7bf4aa1))
* align export with official eBird record format ([dc8c9c3](https://github.com/jlian/wingdex/commit/dc8c9c35e6b4c44881cb4f5c768cd97616a8df65))
* gate PATCH outing columns behind PRAGMA capability checks ([4fc9994](https://github.com/jlian/wingdex/commit/4fc99945fd634e1c69d389d0c89040da048ff068))
* handle photo write race and avoid observation id collisions ([5d911a7](https://github.com/jlian/wingdex/commit/5d911a75ece9867d199e4e35e91f7a31b062daf8))
* preserve region fields on partial migrations and improve upload toasts ([b0a583a](https://github.com/jlian/wingdex/commit/b0a583acc4198795ea6f205aaef5eaca06977aed))
* repair malformed import line in outings/[id].ts ([9d116b6](https://github.com/jlian/wingdex/commit/9d116b6fde34dd801435a5c033ac7d02deaf2624))
* restore stacked save and lifer toasts in upload flow ([e7713aa](https://github.com/jlian/wingdex/commit/e7713aa811f54265ce5df12347cc4020abdb18c6))
* show lifer confetti per outing and avoid stacked upload toasts ([892a9c9](https://github.com/jlian/wingdex/commit/892a9c906ddf1cdd9de09d428e5dcccfa2a75743))
* stabilize local e2e server and import confirm path ([d985027](https://github.com/jlian/wingdex/commit/d9850272e41627bf694e13762694dc7b2820b4f9))


### Features

* expand eBird outing schema and geocode metadata reuse ([947c140](https://github.com/jlian/wingdex/commit/947c140d55640b16ce4e665d5fb12debf195a36e))
* make sightings export roundtrip with eBird import ([4ab3d30](https://github.com/jlian/wingdex/commit/4ab3d30a047d1396563ac3c0daf2ef9c63f01af2))
* store outing region metadata and export checklist duration ([25eff52](https://github.com/jlian/wingdex/commit/25eff52f6d53b3d283eaa399e815e2d81ec21769))


### Performance Improvements

* cache PRAGMA table_info lookups per isolate ([1330750](https://github.com/jlian/wingdex/commit/1330750c4d7e072315262cc2d6268e46408439e6))

## [1.7.2](https://github.com/jlian/wingdex/compare/v1.7.1...v1.7.2) (2026-02-24)


### Performance Improvements

* add loading=lazy to bird thumbnail images ([#112](https://github.com/jlian/wingdex/issues/112)) ([6e0983f](https://github.com/jlian/wingdex/commit/6e0983fb236b3450e088dcf051fb2b016ab0f880))
* build Map indices for O(1) outing/dex lookups ([#108](https://github.com/jlian/wingdex/issues/108)) ([1728766](https://github.com/jlian/wingdex/commit/17287660a636695304a12f93b11ce2e91fcf7b6e))
* memoize derived data on HomePage ([#111](https://github.com/jlian/wingdex/issues/111)) ([4ac5e1d](https://github.com/jlian/wingdex/commit/4ac5e1dff08e9a32d0222acbcdddf9db3ac57152))
* persist Wikipedia REST cache in localStorage ([#113](https://github.com/jlian/wingdex/issues/113)) ([83c6692](https://github.com/jlian/wingdex/commit/83c66924764c57e99b7276cced3af0e8e5480d3b))
* remove 7 unused scaffold deps and UI files ([#114](https://github.com/jlian/wingdex/issues/114)) ([8bb00d0](https://github.com/jlian/wingdex/commit/8bb00d0fcc877339a7c68904b0952e841cca3db9))
* self-host Inter and Newsreader fonts, remove Google Fonts CDN ([#118](https://github.com/jlian/wingdex/issues/118)) ([6224d9a](https://github.com/jlian/wingdex/commit/6224d9a9ec31b1227024f2b1f4620a53e783a5de))
* stabilize inline handlers with useCallback in App.tsx ([#110](https://github.com/jlian/wingdex/issues/110)) ([429c647](https://github.com/jlian/wingdex/commit/429c647e047fc7adca2af548a0c3fdddc511e56c))
* wrap BirdRow in React.memo ([#109](https://github.com/jlian/wingdex/issues/109)) ([d815848](https://github.com/jlian/wingdex/commit/d8158485ba71f18d5eaeda56e6492b909236da41))

## [1.7.1](https://github.com/jlian/wingdex/compare/v1.7.0...v1.7.1) (2026-02-24)


### Bug Fixes

* correct photo caption when AI crop is active ([77632c3](https://github.com/jlian/wingdex/commit/77632c300f2d9e462cc1b4d6e4993fe41a766b9f))
* reject non-photograph images in bird ID prompt ([74c438d](https://github.com/jlian/wingdex/commit/74c438d0c249c540d05be435b039437dcda45b5a)), closes [#188](https://github.com/jlian/wingdex/issues/188)

# [1.7.0](https://github.com/jlian/wingdex/compare/v1.6.4...v1.7.0) (2026-02-24)


### Bug Fixes

* address PR review comments ([d6c5f81](https://github.com/jlian/wingdex/commit/d6c5f81f495154721dbd951a351b61175963ce56))
* address remaining PR review comments ([502e324](https://github.com/jlian/wingdex/commit/502e324727f698288959df526a9f1d132c92a53d))
* align crop previews and prioritize recrop before escalation ([bd92edc](https://github.com/jlian/wingdex/commit/bd92edcb22aff78a12dc6bd8655f64dd6ad6ef09))
* dedupe species count in toast and fix useEffect deps warning ([b815d3f](https://github.com/jlian/wingdex/commit/b815d3f19d485028748cf6b9cabb82d6c5f4d2ab))
* **e2e:** update csv-upload assertions to match completion flow ([930d98e](https://github.com/jlian/wingdex/commit/930d98e478f450cf3321d05c35fa027e0bf82f3f))
* **ios:** remove page fade animations causing swipe-back flash ([9aa0967](https://github.com/jlian/wingdex/commit/9aa0967bb25123df72b43091ad41f833607283a2))
* **ios:** remove remaining HomePage fade on restore ([c7524a8](https://github.com/jlian/wingdex/commit/c7524a8ad8f8683f080442afdf0ae23d46968157))
* match logged-out button style to logged-in gradient ([c81ea3c](https://github.com/jlian/wingdex/commit/c81ea3cee80730857a6bcd6af057e6aa7bdc2767))
* match progress image size to confirm step and always show subtitle ([1eda8d9](https://github.com/jlian/wingdex/commit/1eda8d9b116b9be6e6d565ebd950a13ce212ba70))
* normalize WingDex detail top spacing under header ([d982945](https://github.com/jlian/wingdex/commit/d982945fdd607374ea72e3276c7091b55f330eef))
* remove invalid location_hint from d1_databases config ([c1618eb](https://github.com/jlian/wingdex/commit/c1618eba72e3aa7f2f0a23b966115b6dfca5f12b))
* rename Add button to Upload & Identify ([d0deb89](https://github.com/jlian/wingdex/commit/d0deb890943f0723442fce0f5940a6643d7b5b0b))
* revert multipleBirds prompt to flag individuals not species ([cf166a8](https://github.com/jlian/wingdex/commit/cf166a87fcba60378b5b22b6763b841334d12b2e))
* stricter imageDataUrl validation in JSON branch ([44bcc5c](https://github.com/jlian/wingdex/commit/44bcc5c38bdafc52333abb3929f4300cac9068b9))


### Features

* confetti, toast polish, and confirm step redesign ([29ce8e3](https://github.com/jlian/wingdex/commit/29ce8e3d88dc792ac8e0803b1df1ab147c5c27d3))
* dual-condition escalation and calibrated progress bar ([e117f65](https://github.com/jlian/wingdex/commit/e117f6546cf29883a230237889c66d4d622990f6))
* shared WikiBirdThumbnail component and wider crop padding ([579d6d8](https://github.com/jlian/wingdex/commit/579d6d8b70180af02e5efc80cb3477a0a6523bd8))
* two-tier bird ID pipeline with JSON API ([cdc6f33](https://github.com/jlian/wingdex/commit/cdc6f337ba4c8851b0a053556dde40896737838f))
* upload flow UX improvements ([09530e1](https://github.com/jlian/wingdex/commit/09530e1f144c0daa732b8bde216afd7985bd3c57))

## [1.6.4](https://github.com/jlian/wingdex/compare/v1.6.3...v1.6.4) (2026-02-24)


### Performance Improvements

* cold-start optimization, Turnstile removal, CI deploy verification ([#189](https://github.com/jlian/wingdex/issues/189)) ([1c8c53e](https://github.com/jlian/wingdex/commit/1c8c53e739491c411a0e2297251e2c9cd35b2ff3))

## [1.6.3](https://github.com/jlian/wingdex/compare/v1.6.2...v1.6.3) (2026-02-23)


### Bug Fixes

* enable Workers Observability and request logging ([#184](https://github.com/jlian/wingdex/issues/184)) ([20da3fe](https://github.com/jlian/wingdex/commit/20da3fe629634adb1a8534671543592d7ff60351))

## [1.6.2](https://github.com/jlian/wingdex/compare/v1.6.1...v1.6.2) (2026-02-23)


### Bug Fixes

* edge security hardening + Cloudflare AI Gateway ([#180](https://github.com/jlian/wingdex/issues/180)) ([2ef6874](https://github.com/jlian/wingdex/commit/2ef6874440ef056ba2f32382bb7b5d8da09eb3f7))

## [1.6.1](https://github.com/jlian/wingdex/compare/v1.6.0...v1.6.1) (2026-02-23)


### Bug Fixes

* add Cloudflare Turnstile to anonymous sign-in ([#173](https://github.com/jlian/wingdex/issues/173)) ([265a4b0](https://github.com/jlian/wingdex/commit/265a4b0c6cb73ef46e643936b8c4c5333b36f1d2))

# [1.6.0](https://github.com/jlian/wingdex/compare/v1.5.4...v1.6.0) (2026-02-23)


### Bug Fixes

* address remaining PR review comments ([ffb8ace](https://github.com/jlian/wingdex/commit/ffb8ace63d66ee5f1460d4f8ea684e928a83ce20))
* address review - dynamic timezone offsets, auth provider fallback ([cc2b5b1](https://github.com/jlian/wingdex/commit/cc2b5b14e1f69638cc5f3e7b346982650976b340))
* address round-3 review comments ([89554cc](https://github.com/jlian/wingdex/commit/89554cc620d14760489167ec7abd1f0a9bfbb432))
* align hero image block indentation ([fa1194b](https://github.com/jlian/wingdex/commit/fa1194bc7e5b7796115c950b8dbc67ffdb3db3f7))
* batch UI/UX fixes for issues [#141](https://github.com/jlian/wingdex/issues/141), [#149](https://github.com/jlian/wingdex/issues/149), [#153](https://github.com/jlian/wingdex/issues/153), [#160](https://github.com/jlian/wingdex/issues/160), [#161](https://github.com/jlian/wingdex/issues/161), [#162](https://github.com/jlian/wingdex/issues/162), [#163](https://github.com/jlian/wingdex/issues/163) ([518d745](https://github.com/jlian/wingdex/commit/518d745a7975b67c28dbf4961b2b4319522e7cfd))
* keep blurred hero base visible and slow full-res crossfade ([7d2d136](https://github.com/jlian/wingdex/commit/7d2d1361ebbab0ad51b548d91ffa772de2b8f39f))
* make hero full-res crossfade visible for cached loads ([0a16598](https://github.com/jlian/wingdex/commit/0a165987ad66a2fc46cabbd5516bfd21352a604f))
* remove loading sightings text on homepage ([83da628](https://github.com/jlian/wingdex/commit/83da6284cd5327c9c991c00a479757cb62eb3fb6))
* replace stale APP_VERSION fallback with 'dev' ([c36bc00](https://github.com/jlian/wingdex/commit/c36bc0032aec2dd280cf21a2f7b89d049704a0c3))
* update originalSocialImage ref when user.image changes ([e4b72e6](https://github.com/jlian/wingdex/commit/e4b72e66d56123c14bc106e5d6c6eaf1873bad68))
* use wrangler deployment URL and harden hero image transition ([c072b30](https://github.com/jlian/wingdex/commit/c072b30099aac06754bf56f9e8fc898e0ed9b013))


### Features

* add ™ notices and link version to changelog ([6acc0e0](https://github.com/jlian/wingdex/commit/6acc0e058471e56ef088c9d42fe83e7547b7f72f))
* progressive blur-to-sharp hero image transition ([9ab23d1](https://github.com/jlian/wingdex/commit/9ab23d1c3c066c6157da215a22ba33f93222271c))


### Performance Improvements

* share Wikipedia API cache between image and summary lookups ([6519eaf](https://github.com/jlian/wingdex/commit/6519eaf2a4d1f9358a24c5eb134416b754892090))

## [1.5.4](https://github.com/jlian/wingdex/compare/v1.5.3...v1.5.4) (2026-02-23)


### Bug Fixes

* add robot.txt ([380597b](https://github.com/jlian/wingdex/commit/380597b3b31af784f27189039b60b792a5423113))

## [1.5.3](https://github.com/jlian/wingdex/compare/v1.5.2...v1.5.3) (2026-02-23)


### Bug Fixes

* strip parenthesized scientific name in getEbirdCode ([#164](https://github.com/jlian/wingdex/issues/164)) ([b5844aa](https://github.com/jlian/wingdex/commit/b5844aa5e73fc0709453ad920356ee0157262a5f))

## [1.5.2](https://github.com/jlian/wingdex/compare/v1.5.1...v1.5.2) (2026-02-23)


### Bug Fixes

* **auth:** trust Apple callback origin and gate release build ([797b7f1](https://github.com/jlian/wingdex/commit/797b7f1edd82888d7f105b86d3de63fda69a45cc))

## [1.5.1](https://github.com/jlian/wingdex/compare/v1.5.0...v1.5.1) (2026-02-23)


### Bug Fixes

* build after semantic-release and update main deploy checklist ([4a1a8eb](https://github.com/jlian/wingdex/commit/4a1a8eb82ef2ed71830a998785648d74ec06b2f3))

# [1.5.0](https://github.com/jlian/wingdex/compare/v1.4.2...v1.5.0) (2026-02-23)


### Bug Fixes

* add best adjective ([2d2f49f](https://github.com/jlian/wingdex/commit/2d2f49f9f07116f1f224b8e538e32a004fe2bc40))
* add error/success toast feedback for GitHub link flow ([d9616cd](https://github.com/jlian/wingdex/commit/d9616cdf453009741fc6d20944c7089c7df79075))
* address PR review comments ([#145](https://github.com/jlian/wingdex/issues/145)) ([58946c4](https://github.com/jlian/wingdex/commit/58946c486500d4bf5e3adf0a37daa715494f3c26))
* address PR review feedback on auth, taxonomy, docs, and tests ([dfdebc1](https://github.com/jlian/wingdex/commit/dfdebc110b258a27003738c054eac43801dd4594))
* address review comments and fix CI e2e failure ([288aeac](https://github.com/jlian/wingdex/commit/288aeac48dcd3804e23034d19f0a998fa13c18e5))
* address review feedback for avatar decode and autocomplete cleanup ([91deb9c](https://github.com/jlian/wingdex/commit/91deb9c1657c29dc3fa1817f69dabdb8f1bf4a17))
* address unresolved PR review comments ([b6cce64](https://github.com/jlian/wingdex/commit/b6cce6435e159d4df6bdbee2fbb5edb565f19e46))
* apply local auth retry across api entry points ([6fb33f2](https://github.com/jlian/wingdex/commit/6fb33f293c4d697387d87fe5632adbf54d9dba13))
* **auth:** add passkey sign-in link to signup view ([6295129](https://github.com/jlian/wingdex/commit/6295129974ec7bd1068f1efee93e09abf48e23b5))
* **auth:** align local origin resolution for two-port dev ([7081cf3](https://github.com/jlian/wingdex/commit/7081cf38e6c339694e9296c27bb37c5105203225))
* **auth:** prevent BootShell from unmounting dialog during signup ([1dae441](https://github.com/jlian/wingdex/commit/1dae441733f2f9c786f9cc1b2297286264c4960c))
* **auth:** restore hosted passkey signup with guarded bootstrap ([f4ad785](https://github.com/jlian/wingdex/commit/f4ad7855f1ae93dd5a0911d6c0747c08a6927844))
* **auth:** smooth signup dialog close + direct sign-in on login page ([adb6155](https://github.com/jlian/wingdex/commit/adb6155d4ae6053446cb763e422fa8ffedca17bc))
* block anonymous sessions from passkey login ([9af6d5b](https://github.com/jlian/wingdex/commit/9af6d5b1d53028d7ec5b0b4fa7978b9d566d6608))
* **build:** exclude auth-config test from tsc ([576cf94](https://github.com/jlian/wingdex/commit/576cf949a87428804da3a2a9ff1f231d68273748))
* **ci:** add --env preview to dev D1 migration command ([2033192](https://github.com/jlian/wingdex/commit/2033192e7c03242150dc2cb9c8ab7da0c704ab58))
* **ci:** remove per-run Pages secret setup from CI workflow ([55f82cf](https://github.com/jlian/wingdex/commit/55f82cf818ebeeaf267a4499b4594759171b8b09))
* derive Better Auth baseURL from request origin for preview deploys ([baf97bb](https://github.com/jlian/wingdex/commit/baf97bbd881624416751e91b1a9fbb1c84aa90bc))
* disable secure auth cookies on local origins ([9058465](https://github.com/jlian/wingdex/commit/905846539110eb169c9a9e73f0b8b858c28c618d))
* finalize ai endpoint migration and stabilize tests ([e21ca8f](https://github.com/jlian/wingdex/commit/e21ca8fbae2be27a3d7242d653b6d51063d286be))
* finalize passkey signup and align passkey schema ([6ed5348](https://github.com/jlian/wingdex/commit/6ed53486cd7b041ae4fd5c561b586c0d17227fae))
* harden csv upload retry and e2e full-stack server ([b915382](https://github.com/jlian/wingdex/commit/b91538204d4b30e33e9b278f4f1b3c798b0f16a1))
* harden full local dev startup on occupied ports ([6fab948](https://github.com/jlian/wingdex/commit/6fab948ae2e4050bf7080eb31682753b52153341))
* harden wingdex data reconciliation against stale refresh races ([a6701dc](https://github.com/jlian/wingdex/commit/a6701dcc99dbafbb5b188280f077fb4b70f734a5))
* hash entire file when smaller than 128KB ([1a9a8b6](https://github.com/jlian/wingdex/commit/1a9a8b63ad0e9a8a57ec8d624a3b20ef4eabd0b5))
* **import:** count only truly new species in import result ([6babdc8](https://github.com/jlian/wingdex/commit/6babdc8e364642139f9daa0c76b8764b91d3d5cc))
* keep csv import success toast visible before reload ([f8626b3](https://github.com/jlian/wingdex/commit/f8626b3ef7921c772aa7ee9ee803251a347fd2e9))
* make dev restart forceful and macOS-safe ([30fb6b3](https://github.com/jlian/wingdex/commit/30fb6b38ce8f55b6c4affe3a9efedf017e10cc37))
* move toast to bottom-center to avoid overlapping tab bar ([ac8a729](https://github.com/jlian/wingdex/commit/ac8a72963052fcc6b4dc01de2bf2e4d062ba62a6))
* **passkeys:** allow rename regardless of current label format ([0bafebd](https://github.com/jlian/wingdex/commit/0bafebd07ebabee11515821ce826e4dd98422225))
* **passkeys:** preserve custom labels in device-parentheses format ([bc23742](https://github.com/jlian/wingdex/commit/bc237421238c54607f442d7d21a0a4096e9252a7))
* **passkeys:** standardize labels and suppress cancel errors ([caafec1](https://github.com/jlian/wingdex/commit/caafec1f28c630d8581b7aade00a7327f919ddd0))
* **passkeys:** use device-display format and preserve custom names ([f499aba](https://github.com/jlian/wingdex/commit/f499aba8ec45fa97e00bccce31fe8062a7c923cf))
* polish auth flow and first-load transitions ([3c08d63](https://github.com/jlian/wingdex/commit/3c08d639f5459203f36260311e292afe72b08c64))
* recover local auth session for csv import and export ([3867049](https://github.com/jlian/wingdex/commit/3867049acb03e980a70dccfd0b1fbf85547830d1))
* remove _redirects causing infinite loop warning on CF Pages ([214a884](https://github.com/jlian/wingdex/commit/214a884fe4c01188230797e39e9ec012883e62e6))
* remove csv import hard reload with in-app data refresh ([f3d3558](https://github.com/jlian/wingdex/commit/f3d35583cdb08daa9d46c13c130cd1a3c7782f68))
* render social avatars without emoji scaling ([6a2c222](https://github.com/jlian/wingdex/commit/6a2c222af9115c1df878a667c5cd93ffb7cabeb1))
* resolve local auth 403s for profile updates and sign-out ([30d2174](https://github.com/jlian/wingdex/commit/30d2174938a3a05c5d6144072100574cf5b376ae))
* resolve preview auth and review feedback ([6515a38](https://github.com/jlian/wingdex/commit/6515a3832c80e664c8aae33c674fc4d8ff7fa354))
* restore gpt-4.1-mini default and stabilize AI/dev pipeline ([a13f58a](https://github.com/jlian/wingdex/commit/a13f58a4d3d8339056bf926079e1533320e23a78))
* skip redundant CI deploy when release workflow handles the branch ([81bcf47](https://github.com/jlian/wingdex/commit/81bcf470c2100b991b492e562536c9eeaef99291))
* smooth auth transitions and remove add-photos timing shortcuts ([4cab2d1](https://github.com/jlian/wingdex/commit/4cab2d1c5361ee4f8bcf90ae0847b7535e6c07b7))
* stabilize phase 2 validation and test coverage ([dccdd7c](https://github.com/jlian/wingdex/commit/dccdd7c5674b225dca24e2a4b8f584a9b7d4918a))
* toast OAuth redirect errors instead of failing silently ([476a4c3](https://github.com/jlian/wingdex/commit/476a4c33b2e7af4bd9d04b45a876490645272711))
* update prod D1 database ID after recreation ([2c977a1](https://github.com/jlian/wingdex/commit/2c977a1b26537a6340bb63111196993de7970f24))
* use absolute URL for linkSocial callbackURL ([74a9d9d](https://github.com/jlian/wingdex/commit/74a9d9d4ae636bc6027bbb16d83a8f8b461ee3f9))
* use localhost instead of 127.0.0.1 for IPv4/IPv6 compatibility ([9c8e0ce](https://github.com/jlian/wingdex/commit/9c8e0ceb06079fb882160bc6341d8ae458cb3c21))
* use request URL origin for baseURL instead of Origin header ([1b82e6c](https://github.com/jlian/wingdex/commit/1b82e6c30a0fba07267c5fe487b4559a6cd622f0))


### Features

* add clear data endpoint for phase 2 ([5484a10](https://github.com/jlian/wingdex/commit/5484a10bb00ec7c559db0b0963af104dac93360c))
* add dex data endpoint for phase 2 ([4af50ac](https://github.com/jlian/wingdex/commit/4af50aca9aef3f1f98d064212001cbbdfcf29801))
* add eBird export endpoints ([b9a54c3](https://github.com/jlian/wingdex/commit/b9a54c301fd4bea7020a1f8e6c099f08bb470ddd))
* add local dev test playbook and migrate data hook ([ffe493f](https://github.com/jlian/wingdex/commit/ffe493fe286cf30f668ef2237dbca3b1aee96ff9))
* add outings create endpoint for phase 2 ([7703145](https://github.com/jlian/wingdex/commit/7703145d19da538b6f8c28f1287d9203affbb148))
* add outings update and delete endpoints ([dc012c2](https://github.com/jlian/wingdex/commit/dc012c29a6c5c7f80ddbaf2f36eb663d9c22abca))
* add pencil edit button for display name in Settings ([2dbdfdb](https://github.com/jlian/wingdex/commit/2dbdfdb39656daddba91deae2ad3b47275978c58))
* add per-user daily AI rate limiting ([969ad57](https://github.com/jlian/wingdex/commit/969ad5785aaee479c4a2bbc4e7c1edff823853e2))
* add per-user daily AI rate limiting ([d523a01](https://github.com/jlian/wingdex/commit/d523a0148df88c8000a06708a4cfea0f00ab0ad5))
* add photos and observations data endpoints ([32fe822](https://github.com/jlian/wingdex/commit/32fe82240d2af441fca0e40eb2a710ee67ba0702))
* add seed data endpoint for phase 2 ([1f0a09b](https://github.com/jlian/wingdex/commit/1f0a09bbebdac80431b40737eba6dee5daa0cec2))
* add server eBird import preview and confirm ([0486183](https://github.com/jlian/wingdex/commit/0486183f8aa142e3a102958e9c1c99b8ba72acc9))
* add Sign in with Apple and re-enable account linking ([a883c4d](https://github.com/jlian/wingdex/commit/a883c4df31ee3a7296c30063b1d767b59c07fe8e))
* add species search endpoint and server taxonomy ([0f3dc6e](https://github.com/jlian/wingdex/commit/0f3dc6ecf838b6e8dd4448a15d2e10c7d07fd73f))
* **auth:** add Link GitHub button in Settings + allowDifferentEmails ([fc32f10](https://github.com/jlian/wingdex/commit/fc32f10ac929651577d1727d5dbb81a8d0e88c70))
* **auth:** inline signup views, GitHub OAuth, and account linking ([b65f24d](https://github.com/jlian/wingdex/commit/b65f24d8a716d66ff5bcb9de89d88beb1037292b))
* **auth:** unified passkey login with dialog UX and bird-name generator ([be36148](https://github.com/jlian/wingdex/commit/be3614818c081f2117d0e497f0b52a8f9307d6bf))
* complete phase 2 migration cleanup and status updates ([44902d2](https://github.com/jlian/wingdex/commit/44902d22e59b427522d35bacbb028ed3dafa92fc))
* demo-first auth with passkey signup and account management ([#158](https://github.com/jlian/wingdex/issues/158)) ([e9e8299](https://github.com/jlian/wingdex/commit/e9e8299caa801e4c4c70cfd888120fcb41dbdddd))
* migrate auth foundation and start phase 2 data api ([adf3ec7](https://github.com/jlian/wingdex/commit/adf3ec7c839affcf220eb32062d0ea7f27b83925))
* migrate WingDex from GitHub Spark to Cloudflare Pages + D1 ([#147](https://github.com/jlian/wingdex/issues/147)) ([82a4c62](https://github.com/jlian/wingdex/commit/82a4c62596db3e9c4b0db84c8950424ca3544f4a))
* show social sign-in buttons only when provider is configured ([3fe7e94](https://github.com/jlian/wingdex/commit/3fe7e946523ec587b00cbdb8340853b9dbfe4a12))
* switch eBird UI import/export to API endpoints ([2993c15](https://github.com/jlian/wingdex/commit/2993c152103db27093f5183ebe3a1772f6e6a73e))


### Performance Improvements

* replace Radix Select with native select for timezone picker ([92ca1a1](https://github.com/jlian/wingdex/commit/92ca1a12c45e0331e9e6d56a6d49d331aef66044))

## [1.4.2](https://github.com/jlian/wingdex/compare/v1.4.1...v1.4.2) (2026-02-18)


### Bug Fixes

* remove thumbnail URL upsizing that causes 404 on iOS ([#133](https://github.com/jlian/wingdex/issues/133)) ([3972663](https://github.com/jlian/wingdex/commit/397266364d2566f4595b6e7dcd3a68362e753764))

## [1.4.1](https://github.com/jlian/wingdex/compare/v1.4.0...v1.4.1) (2026-02-17)


### Bug Fixes

* address PR review feedback for perf tests and dialogs ([6a3c31f](https://github.com/jlian/wingdex/commit/6a3c31f19382ef45df5a88005d6a49a93cf573a7))
* clean up auto-load listeners when pagination completes ([ef679af](https://github.com/jlian/wingdex/commit/ef679afef1060e1c13b85ba85fe74aa2d08f4eea))
* complete issue [#105](https://github.com/jlian/wingdex/issues/105) P0 perf and seed taxonomy cleanup ([074fe8a](https://github.com/jlian/wingdex/commit/074fe8aa733e4cddffaa5dd7b4de8aa9a3f9fbe7))
* prevent dialog scroll-lock header shift ([57d5918](https://github.com/jlian/wingdex/commit/57d591865f23a4a3bdc408674cf855201dc7b3d2))


### Performance Improvements

* lazy-load tabs and preserve list controls ([b22bf63](https://github.com/jlian/wingdex/commit/b22bf635dd4e0de1cc3624b956a72766d86a4245))

# [1.4.0](https://github.com/jlian/wingdex/compare/v1.3.2...v1.4.0) (2026-02-17)


### Features

* rename BirdDex to WingDex across app ([#129](https://github.com/jlian/wingdex/issues/129)) ([bacd237](https://github.com/jlian/wingdex/commit/bacd2374fbae125980c958270b5644e71ea03827))

## [1.3.2](https://github.com/jlian/birddex/compare/v1.3.1...v1.3.2) (2026-02-17)


### Bug Fixes

* prevent home empty-state flash during Spark KV load ([#124](https://github.com/jlian/birddex/issues/124)) ([9ac485a](https://github.com/jlian/birddex/commit/9ac485aa0c7bff7d7353e5c167c36e3e1cc20553)), closes [#101](https://github.com/jlian/birddex/issues/101)

## [1.3.1](https://github.com/jlian/birddex/compare/v1.3.0...v1.3.1) (2026-02-17)


### Bug Fixes

* pre-resolve Wikipedia titles at build time to fix iOS image loading ([#99](https://github.com/jlian/birddex/issues/99)) ([ce58c62](https://github.com/jlian/birddex/commit/ce58c627c4c21a16151cc35e33885c1e44c3a21a))

# [1.3.0](https://github.com/jlian/birddex/compare/v1.2.3...v1.3.0) (2026-02-17)


### Features

* enlarge bird detail hero image with overlay text and top-biased crop ([#94](https://github.com/jlian/birddex/issues/94)) ([495fff3](https://github.com/jlian/birddex/commit/495fff37f88b89a8047b0c1fd2ba73e2c441c8a4)), closes [#92](https://github.com/jlian/birddex/issues/92)


### Bug Fixes

* apply top-biased crop to homepage species cards ([e5c401a](https://github.com/jlian/birddex/commit/e5c401a7c3c0b9d50d276dd311e1fa8abed1220e))

## [1.2.3](https://github.com/jlian/birddex/compare/v1.2.2...v1.2.3) (2026-02-16)


### Bug Fixes

* **ci:** make paths-filter v3 compatible on push and PR ([506a6b9](https://github.com/jlian/birddex/commit/506a6b9640dd22a469c080d8bcef5a5ad68038a9))
* **ci:** simplify single-check workflow and enforce lint/typecheck reliability ([#90](https://github.com/jlian/birddex/issues/90)) ([b16d477](https://github.com/jlian/birddex/commit/b16d477835558594210eba3b49dfe48d095e8642))

## [1.2.2](https://github.com/jlian/birddex/compare/v1.2.1...v1.2.2) (2026-02-16)


### Bug Fixes

* reduce expected 404 noise in Spark KV + Wikimedia fallbacks ([#75](https://github.com/jlian/birddex/issues/75)) ([d92fcbf](https://github.com/jlian/birddex/commit/d92fcbf873cec805e365e3d9170cde75851135c1))

## [1.2.1](https://github.com/jlian/birddex/compare/v1.2.0...v1.2.1) (2026-02-16)


### Bug Fixes

* use plain v tags for release-please ([#85](https://github.com/jlian/birddex/issues/85)) ([ab4a2da](https://github.com/jlian/birddex/commit/ab4a2da3df3de4abb6e16589010b1a48f70bcd4f))

# [1.2.0](https://github.com/jlian/birddex/compare/v1.1.0...v1.2.0) (2026-02-16)

### Features
- replace stat cards with compact inline stats on homepage ([3908041](https://github.com/jlian/birddex/commit/3908041))
- replace homepage top with 3 enriched stat cards ([7a1c6bd](https://github.com/jlian/birddex/commit/7a1c6bd))
- minimal typographic homepage header ([0780084](https://github.com/jlian/birddex/commit/0780084))
- E1 homepage layout, rename tab to BirdDex, MapPin outings icon ([ff3996f](https://github.com/jlian/birddex/commit/ff3996f))
- big CTA card homepage, fix skeleton color, smoother bird detail ([02730a2](https://github.com/jlian/birddex/commit/02730a2))
- add AI test fixtures with real LLM responses (#63) ([a251e06](https://github.com/jlian/birddex/commit/a251e06))
- expand AI fixtures to all 27 images, rename for consistency ([c281324](https://github.com/jlian/birddex/commit/c281324))
- Add OG and Twitter image metadata for share previews ([a9744c6](https://github.com/jlian/birddex/commit/a9744c6))

### Bug Fixes
- Fix species deduplication, crop preview overflow, and Wikipedia attribution (#62) ([8d09bb3](https://github.com/jlian/birddex/commit/8d09bb3))
- UI modernization and bug fixes (#45, #17, #59, #14, #13) ([a39b13b](https://github.com/jlian/birddex/commit/a39b13b))
- unify top bar, homepage overhaul, normalize lists, species dedup ([d689f33](https://github.com/jlian/birddex/commit/d689f33))
- tab trigger feedback + reimport duplicate warning ([2cd1351](https://github.com/jlian/birddex/commit/2cd1351))
- iOS Mail list style, accent→green, tab hover, homepage consolidation ([6c9e183](https://github.com/jlian/birddex/commit/6c9e183))
- restore hover/active feedback on lists, fix homepage highlights layout, add cursor-pointer consistency ([ad3de97](https://github.com/jlian/birddex/commit/ad3de97))
- image sizing, hover alignment, highlights grid, homepage outing feedback ([5672f0f](https://github.com/jlian/birddex/commit/5672f0f))
- restore inset borders with rounded hover, icon-only back buttons, MapPin outings ([da6ccca](https://github.com/jlian/birddex/commit/da6ccca))
- move border-b to outer row div, add Back text to back buttons ([e4947b5](https://github.com/jlian/birddex/commit/e4947b5))
- restore iOS Mail inset border, fix double-navigation on BirdRow click ([151746a](https://github.com/jlian/birddex/commit/151746a))
- consolidate page transitions to fast fade-in, fix scrollbar shift ([698910d](https://github.com/jlian/birddex/commit/698910d))
- neutral skeleton colors, smoother bird detail loading, faster fade ([c4cc27f](https://github.com/jlian/birddex/commit/c4cc27f))
- crossfade skeleton→content on bird detail, elegant borderless hero ([cc9a18d](https://github.com/jlian/birddex/commit/cc9a18d))
- use valid Tailwind size classes for upload button (size-16/20) ([415c615](https://github.com/jlian/birddex/commit/415c615))
- dialog scrollbar shift, redesign footer with GitHub logo ([40f3c93](https://github.com/jlian/birddex/commit/40f3c93))
- override react-remove-scroll-bar margin to prevent dialog shift ([a7e9c7a](https://github.com/jlian/birddex/commit/a7e9c7a))
- keep scrollbar visible during dialog to prevent shift without gutter ([22c56cb](https://github.com/jlian/birddex/commit/22c56cb))
- scrollbar always visible, larger dialog close button, slower fade animation ([2a6cbe6](https://github.com/jlian/birddex/commit/2a6cbe6))
- remove header top gap, add bottom fade edge ([2af976a](https://github.com/jlian/birddex/commit/2af976a))
- update BootShell skeleton to match current header and homepage layout ([29b889c](https://github.com/jlian/birddex/commit/29b889c))
- scroll to top on navigation, restore position on back ([4894ffa](https://github.com/jlian/birddex/commit/4894ffa))
- iOS share/PWA icons - split manifest purposes, add sizes attribute ([6e886e0](https://github.com/jlian/birddex/commit/6e886e0))
- update e2e specs for new nav and address review feedback ([f1494f6](https://github.com/jlian/birddex/commit/f1494f6))
- update E2E specs for nav redesign ([8e82840](https://github.com/jlian/birddex/commit/8e82840))
- use visible locator for Northern Cardinal in outing detail test ([c8b0238](https://github.com/jlian/birddex/commit/c8b0238))
- restore scroll position on back navigation ([c94cb31](https://github.com/jlian/birddex/commit/c94cb31))
- address second round of review comments ([02f8423](https://github.com/jlian/birddex/commit/02f8423))
- regenerate PWA icons from favicon SVG ([c370070](https://github.com/jlian/birddex/commit/c370070))
- regenerate icons with sharp for proper PNG output ([514f898](https://github.com/jlian/birddex/commit/514f898))
- timezone conversion & taxonomy normalization bugs ([1b8b656](https://github.com/jlian/birddex/commit/1b8b656))
- keep taxonomy aligned with eBird, use wiki override for Chukar ([3efe908](https://github.com/jlian/birddex/commit/3efe908))
- use offset-aware ISO for exifTime and outing timestamps ([8c55ecc](https://github.com/jlian/birddex/commit/8c55ecc))
- convert eBird CSV times from profile TZ to observation-local (#59) ([2a9fe08](https://github.com/jlian/birddex/commit/2a9fe08))
- add 'None' option to TZ picker for eBird World region users ([e30b613](https://github.com/jlian/birddex/commit/e30b613))
- update TZ picker help text - region preference doesn't control export ([e2c1a80](https://github.com/jlian/birddex/commit/e2c1a80))
- update TZ help text - eBird doesn't document export timezone ([f7619a7](https://github.com/jlian/birddex/commit/f7619a7))
- clarify TZ help text - it's the submitting device's timezone ([150ca17](https://github.com/jlian/birddex/commit/150ca17))
- relax outing distance threshold when times nearly match (Merlin case) ([b2fd1ce](https://github.com/jlian/birddex/commit/b2fd1ce))
- sort homepage recent species by firstSeenDate to match BirdDex page ([a6dc546](https://github.com/jlian/birddex/commit/a6dc546))
- address remaining PR review comments ([385a65d](https://github.com/jlian/birddex/commit/385a65d))
- Fix manifest 404 by linking manifest.json ([e688180](https://github.com/jlian/birddex/commit/e688180))

### Code Refactoring
- collapse redundant fixture replay tests, reorder bird detail links ([ad9d1a8](https://github.com/jlian/birddex/commit/ad9d1a8))
- tighten timezone pipeline and resolve review concerns ([dd6812c](https://github.com/jlian/birddex/commit/dd6812c))

### Documentation
- clarify zero-based monthIndex in timezone offset API ([2361280](https://github.com/jlian/birddex/commit/2361280))

### Tests
- add 41 timezone edge case tests across all pipelines ([ece4430](https://github.com/jlian/birddex/commit/ece4430))
- harden timezone pipeline with 30 new tests ([c3c716b](https://github.com/jlian/birddex/commit/c3c716b))
- add e2e integration tests for CSV import + photo upload flow ([6a900f4](https://github.com/jlian/birddex/commit/6a900f4))

### Miscellaneous Chores
- editorial left-aligned homepage hero ([9eecd56](https://github.com/jlian/birddex/commit/9eecd56))
- inline species observed on same line as big number ([367cee5](https://github.com/jlian/birddex/commit/367cee5))
- remove italic, move upload button to right as square icon button ([f5630ef](https://github.com/jlian/birddex/commit/f5630ef))
- premium upload button with gradient, layered shadow, hover lift ([408996b](https://github.com/jlian/birddex/commit/408996b))
- premium circular upload button with gradient and shadow ([5ddcbd1](https://github.com/jlian/birddex/commit/5ddcbd1))
- refined rectangular upload button with subtle gradient ([3ef4956](https://github.com/jlian/birddex/commit/3ef4956))
- inline text upload button, left-aligned with content ([e4c2e09](https://github.com/jlian/birddex/commit/e4c2e09))
- square upload button with icon above text, right-aligned ([af11fd9](https://github.com/jlian/birddex/commit/af11fd9))
- minimal hero - species count + Add button, no sub-stats or divider ([8c06d73](https://github.com/jlian/birddex/commit/8c06d73))
- species observed under number, emerald-to-teal gradient Add button ([0c9d796](https://github.com/jlian/birddex/commit/0c9d796))
- italic subtitle, subtle flat gradient, tighter spacing to content ([c589a7c](https://github.com/jlian/birddex/commit/c589a7c))
- emerald-to-teal horizontal gradient on Add button ([257fea5](https://github.com/jlian/birddex/commit/257fea5))
- slightly larger Add button (px-6 py-3, text-base) ([15cd38c](https://github.com/jlian/birddex/commit/15cd38c))
- translucent sticky header, 150ms fade animation ([1b4c85e](https://github.com/jlian/birddex/commit/1b4c85e))
- address review comments: fix date init, bulk update, User-Agent, header comment ([3d5f387](https://github.com/jlian/birddex/commit/3d5f387))
- less rounded Add button, unbold text, align header with content ([53802f0](https://github.com/jlian/birddex/commit/53802f0))
- remove private CSV from tracking, add to gitignore ([7eaeeaf](https://github.com/jlian/birddex/commit/7eaeeaf))
- move eBird timezone setup into import dialog ([588f4f1](https://github.com/jlian/birddex/commit/588f4f1))
- Load PWA manifest from bundled asset to avoid Spark 404 ([0299465](https://github.com/jlian/birddex/commit/0299465))
- Harden iOS home-screen icon metadata and cache-bust touch icon ([7bdb77e](https://github.com/jlian/birddex/commit/7bdb77e))

# [1.1.0](https://github.com/jlian/birddex/compare/v1.0.2...v1.1.0) (2026-02-15)

### Features
- extract saved locations from eBird CSV import ([3cd4b05](https://github.com/jlian/birddex/commit/3cd4b05))
- Add PWA icons and web manifest for share/home screen support ([1a797d6](https://github.com/jlian/birddex/commit/1a797d6))
- Add sorting to outings list and sort home page recent outings by date (#35) ([c93da7a](https://github.com/jlian/birddex/commit/c93da7a))
- Add scientific names to AI inference and Wikipedia reference images to photo confirmation (#44) ([382eec5](https://github.com/jlian/birddex/commit/382eec5))
- Add coding guidelines for LLM coding practices ([c76e951](https://github.com/jlian/birddex/commit/c76e951))

### Bug Fixes
- Fix iOS Wikimedia thumbnail loading and simplify image pipeline ([1ed8a07](https://github.com/jlian/birddex/commit/1ed8a07))
- restore eBird outing grouping when submission IDs are unique ([4c5d057](https://github.com/jlian/birddex/commit/4c5d057))
- Fix lockfile stability by relaxing Node version requirement ([a0fc30d](https://github.com/jlian/birddex/commit/a0fc30d))
- add Merlin to WIKI_OVERRIDES to show bird article instead of mythical figure ([98ed5c6](https://github.com/jlian/birddex/commit/98ed5c6))
- Fix LLM prompt and species selection UX for high-confidence flow (#33) ([f3ebd10](https://github.com/jlian/birddex/commit/f3ebd10))
- Fix issues #46, #48–#56: upload UX, sort toggles, timezone, location, footer (#57) ([affe544](https://github.com/jlian/birddex/commit/affe544))

### Code Refactoring
- remove saved location handling from eBird import flow ([49a5399](https://github.com/jlian/birddex/commit/49a5399))

### Miscellaneous Chores
- Improve eBird CSV import/export and fix type errors ([df78348](https://github.com/jlian/birddex/commit/df78348))
- Revert unintended package-lock.json changes ([05952c0](https://github.com/jlian/birddex/commit/05952c0))
- Update CI configuration, add .npmrc, and enhance documentation for reproducible installs ([1bbdad1](https://github.com/jlian/birddex/commit/1bbdad1))
- sort WIKI_OVERRIDES alphabetically and update comment to cover disambiguation ([a47ba24](https://github.com/jlian/birddex/commit/a47ba24))
- Rework bird list sort toggles to New/Old/Updated/Frequency/A-Z (#34) ([3e6689b](https://github.com/jlian/birddex/commit/3e6689b))
- Pass location name to bird ID prompt for regional species accuracy (#30) ([30c7b03](https://github.com/jlian/birddex/commit/30c7b03))
- Replace saved locations with outing name autocomplete (#41) ([dfe28f7](https://github.com/jlian/birddex/commit/dfe28f7))

## [1.0.2](https://github.com/jlian/birddex/compare/v1.0.1...v1.0.2) (2026-02-13)

### Bug Fixes
- eBird links, taxonomy grounding, and Wikipedia coverage ([5b1cb31](https://github.com/jlian/birddex/commit/5b1cb31))

## [1.0.1](https://github.com/jlian/birddex/compare/v1.0.0...v1.0.1) (2026-02-13)

### Features
- harden user isolation and auth guard ([79cbee7](https://github.com/jlian/birddex/commit/79cbee7))

### Bug Fixes
- Fix GitHub Spark link in README ([45d5774](https://github.com/jlian/birddex/commit/45d5774))
- Fix link formatting for GitHub Spark in README ([68233e2](https://github.com/jlian/birddex/commit/68233e2))
- Fix GitHub Spark link in README ([3c04961](https://github.com/jlian/birddex/commit/3c04961))
- Fix GitHub Spark link in README ([afd9df5](https://github.com/jlian/birddex/commit/afd9df5))

### Miscellaneous Chores
- stabilize spark resolution and CI install mode ([f93cc93](https://github.com/jlian/birddex/commit/f93cc93))
- sync settings version from package.json ([3cf43aa](https://github.com/jlian/birddex/commit/3cf43aa))

# [1.0.0](https://github.com/jlian/birddex/compare/v0.9.0...v1.0.0) (2026-02-13)

### Highlights
- Reached first stable major release with core BirdDex flows: dark mode, outing title editing, and eBird record-format export.
- Hardened Spark runtime boundaries and KV behavior, including host-gated Spark calls and repeated fetch-loop fixes.
- Improved reliability and UX across theming, portals, dashboard/upload surfaces, and location handling.
- Expanded test coverage (unit, clustering, runtime behavior) and enabled PR smoke-test CI.

<details>
<summary>Historical commit details (1.0.0)</summary>

### Features
- add dark mode support ([95b6674](https://github.com/jlian/birddex/commit/95b6674))
- Add outings title editing with default location reset ([2254dc5](https://github.com/jlian/birddex/commit/2254dc5))
- export record-format CSV and add conformance tests ([d24c628](https://github.com/jlian/birddex/commit/d24c628))
- Add close confirmation dialog, extract helpers, expand e2e tests ([1cefaab](https://github.com/jlian/birddex/commit/1cefaab))
- Add unit tests for P0-P2 coverage gaps ([bcd93ca](https://github.com/jlian/birddex/commit/bcd93ca))

### Bug Fixes
- fix css token scope and stabilize dex/theme flows ([610be90](https://github.com/jlian/birddex/commit/610be90))
- prevent first-paint theme flash ([7b3e852](https://github.com/jlian/birddex/commit/7b3e852))
- gate Spark runtime/KV calls to Spark hosts ([6c97ca0](https://github.com/jlian/birddex/commit/6c97ca0))
- Fix dialog portals to inherit app theme styles ([ff16ca4](https://github.com/jlian/birddex/commit/ff16ca4))
- reconcile dex aggregates and improve privacy-safe location handling ([ec48951](https://github.com/jlian/birddex/commit/ec48951))
- Fix broken pic ([c5de7fd](https://github.com/jlian/birddex/commit/c5de7fd))
- Fix useKV function call ([59867ac](https://github.com/jlian/birddex/commit/59867ac))
- Fix KV probe URL: use /_spark/kv instead of /_spark/kv/keys ([ebdaa01](https://github.com/jlian/birddex/commit/ebdaa01))
- Fix KV probe: test individual key instead of unsupported listing endpoint ([f32e18a](https://github.com/jlian/birddex/commit/f32e18a))
- stop repeated Spark KV fetch loops on rerender ([09ead78](https://github.com/jlian/birddex/commit/09ead78))

### Code Refactoring
- standardize app mount container to spark-app ([6389b02](https://github.com/jlian/birddex/commit/6389b02))
- split Spark KV and localStorage by runtime ([911b9a4](https://github.com/jlian/birddex/commit/911b9a4))

### Tests
- make unit test script auto-discover tests ([0c06da1](https://github.com/jlian/birddex/commit/0c06da1))
- cover stable fallback dev user id behavior ([5eee156](https://github.com/jlian/birddex/commit/5eee156))
- Rewrite README, tighten clustering thresholds to 5hr/6km, add clustering tests, fix resizable.tsx types ([819c3ef](https://github.com/jlian/birddex/commit/819c3ef))
- add local and Spark runtime coverage for useKV ([b55bfbd](https://github.com/jlian/birddex/commit/b55bfbd))

### Continuous Integration
- run smoke tests on pull requests ([94d43f5](https://github.com/jlian/birddex/commit/94d43f5))

### Miscellaneous Chores
- Rename Life List to BirdDex ([23c2c30](https://github.com/jlian/birddex/commit/23c2c30))
- remove temporary root token fallback ([b703b34](https://github.com/jlian/birddex/commit/b703b34))
- fix tailwind screens and make KV sync resilient ([b40f864](https://github.com/jlian/birddex/commit/b40f864))
- use stable local fallback user id ([d291858](https://github.com/jlian/birddex/commit/d291858))
- add boot shell and subtle app fade-in ([c53152d](https://github.com/jlian/birddex/commit/c53152d))
- Standardize portal mounting to app root ([18b03a1](https://github.com/jlian/birddex/commit/18b03a1))
- Align BirdDex sighting list with outing list style ([1d73210](https://github.com/jlian/birddex/commit/1d73210))
- Redesign species detail: square image + inline stats, no cards ([68ee797](https://github.com/jlian/birddex/commit/68ee797))
- add flat eslint config and refresh README ([bc67387](https://github.com/jlian/birddex/commit/bc67387))
- Remove stale test:smoke reference from README ([19d12ae](https://github.com/jlian/birddex/commit/19d12ae))
- Update hero taglines to highlight privacy, batch upload, and cross-referencing ([a744479](https://github.com/jlian/birddex/commit/a744479))
- Simplify hero CTA: rename button and condense taglines ([ad36f7b](https://github.com/jlian/birddex/commit/ad36f7b))
- Restyle home dashboard and upload dialog ([fc71c4a](https://github.com/jlian/birddex/commit/fc71c4a))
- v1.0.0: polish copy, move Upload & Identify to home page, bump version ([f66f3a8](https://github.com/jlian/birddex/commit/f66f3a8))
- Generated by Spark: Please commit the latest changes I just fixed a test ([6bf444e](https://github.com/jlian/birddex/commit/6bf444e))
- Revert "Fix useKV function call" ([5de1fce](https://github.com/jlian/birddex/commit/5de1fce))
- Restore package-lock.json to pre-rewrite state ([182fde3](https://github.com/jlian/birddex/commit/182fde3))
- Rewrite useKV: KV-only in prod, localStorage dev-only with banner ([44ed17e](https://github.com/jlian/birddex/commit/44ed17e))
- Untrack and ignore package-lock.json ([5df7f63](https://github.com/jlian/birddex/commit/5df7f63))
- Restore original package-lock.json for CI ([927e021](https://github.com/jlian/birddex/commit/927e021))
- Revert "Rewrite useKV: KV-only in prod, localStorage dev-only with banner" ([19323f6](https://github.com/jlian/birddex/commit/19323f6))
- Auto-lookup location name from GPS instead of requiring manual button click ([c02e823](https://github.com/jlian/birddex/commit/c02e823))
- Trim README ([b288c9b](https://github.com/jlian/birddex/commit/b288c9b))

</details>

## [0.9.0](https://github.com/jlian/birddex/compare/v0.8.0...v0.9.0) (2026-02-13)

### Features
- Add eBird taxonomy for species autocomplete and AI grounding ([e2990d8](https://github.com/jlian/birddex/commit/e2990d8))
- Add tests for taxonomy, AI inference, and AddPhotosFlow logic ([8d018b0](https://github.com/jlian/birddex/commit/8d018b0))

### Bug Fixes
- Fix Skip crash and improve 429 error message ([911dff0](https://github.com/jlian/birddex/commit/911dff0))
- surface errors to user - toast on geocode/import failures, detailed messages ([278487a](https://github.com/jlian/birddex/commit/278487a))
- remove dead suggestBirdCrop, throw on unparseable AI response ([ee4ee19](https://github.com/jlian/birddex/commit/ee4ee19))

### Code Refactoring
- extract crop-math module, export parseEXIF for testability ([c53a413](https://github.com/jlian/birddex/commit/c53a413))

### Documentation
- add CONTRIBUTING.md, CODE_OF_CONDUCT.md, and package.json metadata ([f36303b](https://github.com/jlian/birddex/commit/f36303b))

### Tests
- import source functions, delete redundant integration tests ([953a87d](https://github.com/jlian/birddex/commit/953a87d))

### Continuous Integration
- run all tests instead of hardcoded subset ([4c9ec46](https://github.com/jlian/birddex/commit/4c9ec46))

## [0.8.0](https://github.com/jlian/birddex/compare/v0.7.0...v0.8.0) (2026-02-13)

### Bug Fixes
- align react-dom version with react to fix #527 mismatch error ([8c2b23b](https://github.com/jlian/birddex/commit/8c2b23b))

### Miscellaneous Chores
- Bump react and @types/react (#1) ([0e49fb1](https://github.com/jlian/birddex/commit/0e49fb1))
- Bump eslint-plugin-react-refresh from 0.4.24 to 0.5.0 (#4) ([ea03c89](https://github.com/jlian/birddex/commit/ea03c89))
- Bump @vitejs/plugin-react-swc from 4.2.2 to 4.2.3 (#5) ([d0fc789](https://github.com/jlian/birddex/commit/d0fc789))
- Simplify CI to build-only, update README ([ae36dcb](https://github.com/jlian/birddex/commit/ae36dcb))
- Update title to BirdDex, use Phosphor Bird favicon, bird pics ([1d3ccf2](https://github.com/jlian/birddex/commit/1d3ccf2))
- Bump react-resizable-panels from 2.1.9 to 4.6.2 (#2) ([d7d56e2](https://github.com/jlian/birddex/commit/d7d56e2))
- Bump eslint-plugin-react-hooks from 5.2.0 to 7.0.1 (#3) ([0c813b2](https://github.com/jlian/birddex/commit/0c813b2))

## [0.7.0](https://github.com/jlian/birddex/compare/v0.6.0...v0.7.0) (2026-02-13)

### Miscellaneous Chores
- eBird import creates outings, add import instructions, confetti on new species ([936e4e8](https://github.com/jlian/birddex/commit/936e4e8))

## [0.6.0](https://github.com/jlian/birddex/compare/v0.5.0...v0.6.0) (2026-02-13)

### Code Refactoring
- extract shared utilities, remove dead code ([cc491d3](https://github.com/jlian/birddex/commit/cc491d3))

### Tests
- Extract shared BirdRow/StatCard components, fix tests, add CI ([eb08078](https://github.com/jlian/birddex/commit/eb08078))

### Miscellaneous Chores
- Polish detail pages, fix nav bug, reorder settings, clean up stale files ([b838f76](https://github.com/jlian/birddex/commit/b838f76))
- Update docs, fix CI console error filter, remove UX_FIXES.md ([ac4d5f1](https://github.com/jlian/birddex/commit/ac4d5f1))

## [0.5.0](https://github.com/jlian/birddex/compare/v0.4.0...v0.5.0) (2026-02-13)

### Features
- consistent cards, animations, seed data, delete data ([59906bd](https://github.com/jlian/birddex/commit/59906bd))

### Bug Fixes
- consistent layout, hash routing, visual polish ([57ba8eb](https://github.com/jlian/birddex/commit/57ba8eb))

### Miscellaneous Chores
- Compact Merlin-style rows, sorting, tighter spacing, logo nav ([e4aacae](https://github.com/jlian/birddex/commit/e4aacae))

## [0.4.0](https://github.com/jlian/birddex/compare/v0.3.0...v0.4.0) (2026-02-13)

### Features
- outing detail view, saved locations UI, title/favicon, PRD updates ([1750b7a](https://github.com/jlian/birddex/commit/1750b7a))
- responsive desktop layout, top nav, homepage redesign, species detail view ([cb0a8b3](https://github.com/jlian/birddex/commit/cb0a8b3))

### Miscellaneous Chores
- add implementation status + priorities; stop persisting photo blobs to KV ([1371660](https://github.com/jlian/birddex/commit/1371660))

## [0.3.0](https://github.com/jlian/birddex/compare/v0.2.0...v0.3.0) (2026-02-13)

### Features
- Add Playwright smoke tests (7 tests: load, nav, dialog, mobile viewport) ([11161ea](https://github.com/jlian/birddex/commit/11161ea))

### Miscellaneous Chores
- UX overhaul: reverse-birding identity, Wikimedia images, outing merging, 8hr clustering ([70623fa](https://github.com/jlian/birddex/commit/70623fa))

## [0.2.0](https://github.com/jlian/birddex/compare/v0.1.0...v0.2.0) (2026-02-13)

### Bug Fixes
- Fix mobile crop, rework bird ID flow, add AI zoom, add tests ([ed04cbc](https://github.com/jlian/birddex/commit/ed04cbc))
- Fix 11 UX issues: crop overlay, back nav, accessibility, error handling ([a8a4c9a](https://github.com/jlian/birddex/commit/a8a4c9a))
- Fix AI zoom: use canvas crop instead of broken CSS percentage math ([b61dbc8](https://github.com/jlian/birddex/commit/b61dbc8))

## [0.1.0](https://github.com/jlian/birddex/releases/tag/v0.1.0) (2026-02-12)

### Highlights
- Bootstrapped the first working BirdDex prototype in Spark, including initial app structure and storage setup.
- Iterated rapidly on crop, identification, and outing-detection behavior during early product discovery.

<details>
<summary>Historical commit details (0.1.0)</summary>

### Features
- Add spark configuration ([b9fe63b](https://github.com/jlian/birddex/commit/b9fe63b))

### Miscellaneous Chores
- Initial commit ([13403ed](https://github.com/jlian/birddex/commit/13403ed))
- Generated by Spark: Build a mobile-first web app called “Bird-Dex” that is its own bird life-list + sighting tracker, and is compatible with eBird (import/export) and Merlin (Merlin-like life list UX + optional eBird bridge). ([0e67380](https://github.com/jlian/birddex/commit/0e67380))
- Generated by Spark: Fix all reported errors. ([13e67e9](https://github.com/jlian/birddex/commit/13e67e9))
- Generated by Spark: How is the list stored? Just on the VM? Or can we have the list be stored in the user GitHub profile, maybe as a gist that could be either public or private? ([d73d091](https://github.com/jlian/birddex/commit/d73d091))
- Generated by Spark: Ok first the outing identification should be automatic via EXIF ([1c8009b](https://github.com/jlian/birddex/commit/1c8009b))
- Generated by Spark: The cropping didn't happen. The birds were not identified. The outing parsing also didn't work, it should mention a place and then ask the user to confirm or edit ([b917f0f](https://github.com/jlian/birddex/commit/b917f0f))
- Generated by Spark: Ok still no cropping and still no bird ID ([2621561](https://github.com/jlian/birddex/commit/2621561))
- Generated by Spark: Why is there still no crop? Are we doing AI crop? I was thinking user crop. Maybe it could be AI crop first and then user confirm? ([ddab6d4](https://github.com/jlian/birddex/commit/ddab6d4))
- Edited Spark ([6dcd4ef](https://github.com/jlian/birddex/commit/6dcd4ef))
- Generated by Spark: I'm still not seeing a crop box or any indication of AI crop ([250f892](https://github.com/jlian/birddex/commit/250f892))
- Generated by Spark: Nope, all the same issues I just mentioned none are fixed, no crop, no outing location detection, and no bird ID ([e132657](https://github.com/jlian/birddex/commit/e132657))
- Edited Spark ([aa1289d](https://github.com/jlian/birddex/commit/aa1289d))
- Generated by Spark: Alright I was just in code spaces making a bunch of changes. Now can you just commit it ([ce1e3da](https://github.com/jlian/birddex/commit/ce1e3da))
- Edited Spark ([4240782](https://github.com/jlian/birddex/commit/4240782))
- Generated by Spark: Please commit ([bd76c39](https://github.com/jlian/birddex/commit/bd76c39))
- Edited Spark ([b87b4e5](https://github.com/jlian/birddex/commit/b87b4e5))
- Generated by Spark: Please commit we fixed the storage situation. Why is it not possible to commit in the codespace ([acd4d27](https://github.com/jlian/birddex/commit/acd4d27))
- Edited Spark ([1336bea](https://github.com/jlian/birddex/commit/1336bea))
- Generated by Spark: Please commit again ([9a89471](https://github.com/jlian/birddex/commit/9a89471))

</details>
