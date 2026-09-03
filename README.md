# WingDex

A photo-first bird identification and life list tracker. Upload your bird photos, identify the species on your device, and build your personal WingDex over time.

**[Try it ->](https://wingdex.app)**

<img width="1150" height="1142" alt="image" src="https://github.com/user-attachments/assets/79c364ae-e4f3-49ba-9fed-6e5966470304" />

## What is WingDex?

WingDex is for **reverse birding**: people who take photos first and identify species later. Instead of checklists and field guides, you upload photos you already took, and the app identifies the birds. You just confirm with a tap.

**Photos never leave your device.** Identification runs entirely in the browser, or natively on iOS. There is no inference server, so there is nothing to upload a photo to.

Drop a whole day's photos at once and the batch wizard clusters them into outings by time and location, identifies each bird, and lets you confirm the lot in one pass. Species link back to the outings you saw them on, and outings link forward to the species, so you can cross-reference either direction.

### Features

- **On-device species ID** - ~11,000 eBird species, reranked by where and when the photo was taken
- **Private by construction** - photos are never uploaded or stored; all bird imagery comes from Wikipedia
- **Batch upload** - photos auto-grouped into outings by time and GPS, merged with existing sessions, deduplicated by hash
- **Life list** - first and last seen, sighting counts, searchable and sortable, with per-species detail and history
- **eBird integration** - import and export checklists and life lists in eBird Record Format
- **Works offline** - after the one-time model download, identification needs no network
- **Accounts** - anonymous sessions, passkeys, and GitHub / Google / Apple sign-in
- **iOS app** - native companion app in [`ios/`](ios/)

## How it works

1. **Upload** photos from your device
2. **EXIF** GPS and timestamps are read in the browser and photos are clustered into outings
3. **Review** the outing: date, auto-geocoded location, notes
4. **Identify** on-device, ranked by visual similarity and then by how likely each species is at that place and time of year
5. **Confirm** the top suggestion, pick an alternative, or skip
6. **Saved** to your WingDex

The first identification downloads about 53 MB of model files, once. After that everything is local and works offline.

### Identification

[WingCLIP-0.3](https://huggingface.co/johnlian/WingCLIP-0.3) is a 39M-parameter image encoder distilled from [BioCLIP-2](https://huggingface.co/imageomics/bioclip-2) via [WingCLIP-0.1](https://huggingface.co/johnlian/WingCLIP-0.1). Small enough to download once and run on a phone.

Vision alone struggles to separate lookalike species, so candidates are reranked against an empirical prior over what has actually been reported in that map cell in that month. Some pairs are hard to tell apart from pixels and trivial to tell apart from geography. With that rerank the pipeline reaches 95.0 percent top-1 on a 3,322-photo held-out split.

The same model, priors, and preprocessing ship on both platforms, and a golden-vector suite pins the two implementations to each other.

## Tech stack

| Layer | Technology |
|-------|------------|
| Platform | Cloudflare Workers, D1 (SQLite) |
| Frontend | React 19, TypeScript, Vite 8 |
| Styling | Tailwind CSS 4, Radix UI primitives, Phosphor Icons |
| Auth | better-auth (anonymous, passkeys, GitHub/Google/Apple OAuth) |
| Identification | WingCLIP-0.3 via ONNX Runtime Web (browser) and Core ML (iOS) |
| Geocoding | Reverse (coordinate to place name) from a local OpenStreetMap PMTiles archive in R2; forward place search proxied to Geoapify |
| Bird imagery | Wikipedia REST API |
| Testing | Vitest (unit), Playwright (e2e), XCTest (iOS) |
| iOS | Swift, XcodeGen |

## Development

Requires Node 24+. No API keys: identification runs on the device, and anonymous auth works out of the box.

```bash
git clone https://github.com/jlian/wingdex.git
cd wingdex
npm install
npm run db:migrate
npm run dev
```

`npm run dev` serves the React app and native Worker API together on `:5000` through the Cloudflare Vite plugin, with HMR for both sides. It binds to all interfaces so the iOS `Localhost` scheme can reach it through the LAN reverse proxy; set `VITE_SERVER_HOST=false` to restrict it to loopback. It creates `.dev.vars` from the example on first run. `npm stop` clears the local server. Local D1 state lives in `~/.cache/wingdex/wrangler-state`.

The `Localhost` iOS scheme expects `localhost.wingdex.app` to resolve from the simulator or device to a LAN HTTPS reverse proxy with a trusted certificate. Configure that proxy to preserve the Host header and forward HTTP and WebSocket traffic to the development Mac on port 5000. After `npm run dev`, verify the path with `dig +short localhost.wingdex.app` and `curl --fail https://localhost.wingdex.app/api/auth/get-session`.

Reverse geocoding reads the private production place archive through a remote
R2 binding while the Worker and D1 stay local. Run `npx wrangler login` before
starting development. Local and CI Playwright runs keep D1 local but read the
real archive through the same remote binding; reverse-geocoding integration
tests do not support an offline local-R2 mode.

Run `npm run check` (lint, typecheck, unit) before pushing, and `npm run check:all` (adds e2e and a production build) when the change touches `functions/`, `e2e/`, routing, auth, or data flow. Everything runnable is in `package.json` under `scripts`.

| Path | Purpose |
|------|---------|
| `src/components/` | React components: `ui/` primitives, `pages/`, `flows/` |
| `src/lib/` | Client-side logic, including identification and ranking |
| `src/__tests__/` | Vitest unit and integration tests |
| `worker/` | Native Cloudflare Worker entry and API routing |
| `functions/` | API route handlers and shared server logic |
| `migrations/` | D1 SQL migrations |
| `e2e/` | Playwright specs |
| `ios/` | Native iOS app (XcodeGen) |
| `ml/` | Model conversion and cross-platform parity harnesses |

## Releases

PR titles follow Conventional Commits (`feat: add outing merge UX`, `fix: handle wiki 404 fallback`). On merge to `main`, Release Please works out the next version, updates `CHANGELOG.md`, and tags it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
