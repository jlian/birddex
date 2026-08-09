# App Store Privacy Labels Worksheet

Use this worksheet when completing App Store Connect. It records implemented behavior, not legal advice. Rows marked **Confirm** require an owner decision before submission.

## Tracking

- [x] WingDex does not use data to track users across other companies' apps or websites.
- [x] WingDex has no advertising SDK, advertising identifier use, or data broker integration.
- [ ] **Confirm:** Answer App Store Connect's tracking question as **No** after reviewing the final uploaded binary's SDK privacy report.

## Data linked to the user

| App Store category | WingDex data | Purpose | Current answer |
|---|---|---|---|
| Contact Info - Name | Display name from an authentication provider or generated nickname | App functionality, account profile | Collected, linked |
| Contact Info - Email Address | Email supplied by Apple, Google, or GitHub when available | App functionality, authentication | Collected, linked |
| Identifiers - User ID | WingDex account ID and provider-issued account identifiers | App functionality, authentication, security | Collected, linked |
| Precise Location | Exact outing coordinates and photo GPS metadata when present | App functionality, outing grouping and history | Collected, linked |
| User Content - Other User Content | Outings, observations, species lists, counts, notes, location names, and imported eBird records | App functionality | Collected, linked |
| Other Data | Photo filename, capture time, and fingerprint hash | App functionality, duplicate detection | Collected, linked |
| Usage Data - Product Interaction | Authenticated API route, status, duration, and safe operational counts | App functionality, security, diagnostics | **Confirm** whether Apple's definitions require disclosure |
| Diagnostics - Performance Data | Request duration and failure status in hosting logs | App functionality, diagnostics | **Confirm** whether Apple's definitions require disclosure |

## Data not collected by WingDex

- [x] **Photos or Videos:** Bird-photo pixels are processed on-device and are not uploaded to or stored by WingDex. Photo metadata is disclosed separately above.
- [x] **Advertising Data:** WingDex has no advertising.
- [x] **Purchases:** WingDex has no subscription or in-app purchase.
- [x] **Health and Fitness, Financial Info, Contacts, Browsing History, Search History:** WingDex does not collect these categories as product data.

Location searches submitted for geocoding and rounded GPS coordinates are forwarded through WingDex to Geoapify. They are not attached to WingDex application logs, and WingDex does not cache provider responses. Geoapify states that successful API request bodies, headers, IP addresses, and timestamps are generally retained for no longer than 24 hours to generate aggregate usage statistics. **Confirm** with App Store Connect guidance whether explicit place queries should be included under Search History despite being location-feature input rather than general web search.

## Deletion and retention evidence

- In-app account deletion removes the active account and associated sessions, passkeys, provider records, outings, observations, photos metadata, and dex metadata after provider revocation succeeds.
- WingDex does not retain a geocoding-provider response cache.
- Automatic Cloudflare trace spans are disabled because outbound fetch spans can include the complete Geoapify URL and API key. Structured Request and Application logs retain W3C trace IDs while excluding raw coordinates, location queries, filenames, notes, and request bodies.
- [ ] **Owner/legal:** Record concrete hosting-log, backup, and disaster-recovery retention periods.
- [ ] **Owner/legal:** Confirm Cloudflare DPA acceptance and record acceptance of Geoapify's terms and privacy policy.

## Final binary checks

- [ ] Generate and review Xcode's privacy report for the exact archive uploaded to App Store Connect.
- [ ] Compare every third-party SDK declaration in that report with this worksheet.
- [ ] Reconcile any App Store Connect warning before submission.