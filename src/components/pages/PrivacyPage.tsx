export default function PrivacyPage() {
  return (
    <div className="px-5 sm:px-8 py-8 sm:py-10 space-y-8 max-w-2xl mx-auto">
      <div className="space-y-2">
        <h2 className="font-serif text-2xl font-semibold text-foreground">Privacy Policy</h2>
        <p className="text-sm text-muted-foreground/90">Last updated: September 2026</p>
      </div>

      <article className="space-y-8 text-[0.9375rem] text-foreground/75 leading-7">
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">1. Introduction</h3>
          <p>This Privacy Policy describes how WingDex™ ("we," "us," or "the Service") collects, uses, and shares information when you use the WingDex web application or iOS app. By accessing or using WingDex, you acknowledge that you have read and understood this policy.</p>
        </section>

        <section className="space-y-4">
          <h3 className="text-base font-semibold text-foreground">2. Information we collect</h3>
          <div className="space-y-2">
            <h4 className="font-medium text-foreground">2.1 Information you provide</h4>
            <ul className="list-disc ml-5 space-y-1.5">
              <li><strong>Account and authentication information:</strong> Display name, email address, profile image, provider-issued account identifiers, and authentication tokens when you use social login. For passkeys, WingDex stores the public key and credential metadata; the private key remains with your device or passkey provider.</li>
              <li><strong>Birding data:</strong> Observations, outings, species lists, counts, identification confidence, notes, dates and times, location names, precise coordinates when present, checklist details, and related metadata you enter into the app.</li>
              <li><strong>Photo metadata:</strong> Images you add for bird identification are processed entirely on your device. WingDex does not upload or store the image pixels. We store associated metadata such as capture time, GPS coordinates when present, file name, and a file fingerprint hash used for duplicate detection.</li>
              <li><strong>Imported data:</strong> When you import an eBird CSV export, the file is uploaded to WingDex for server-side parsing. WingDex stores the resulting birding records, submission identifiers, and an import fingerprint used to prevent duplicate imports, but does not retain the original CSV after the request is processed.</li>
              <li><strong>Private contact information:</strong> If you use the private contact form linked in Section 12, the separately hosted form collects your name, email address, and message, along with technical information including your user agent and referrer.</li>
            </ul>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium text-foreground">2.2 Information collected automatically</h4>
            <ul className="list-disc ml-5 space-y-1.5">
              <li><strong>Session and request data:</strong> Session identifiers and expiration, IP address, user-agent information, authenticated account identifier, requested API route, response status, request duration, trace identifiers, and limited operational counts. WingDex does not include request bodies, photos, coordinates, location searches, file names, or notes in its application logs.</li>
              <li><strong>Device storage:</strong> The web app uses first-party cookies and browser storage for sessions, preferences, and limited content caches. The iOS app stores authentication tokens in the system Keychain and may keep a local cache of your WingDex account data. Photos shared to the iOS app may be staged temporarily on your device while the app imports them. We do not use third-party tracking or advertising cookies.</li>
            </ul>
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">3. How we use your information</h3>
          <ul className="list-disc ml-5 space-y-0.5">
            <li>Provide, operate, and maintain the WingDex application and its features</li>
            <li>Authenticate your identity and manage your account</li>
            <li>Identify birds from your photos on your device, without uploading the image</li>
            <li>Import and export birding records at your request</li>
            <li>Suggest outing names and search for places</li>
            <li>Display species information, media, and related content</li>
            <li>Diagnose failures and understand aggregate service operation</li>
            <li>Monitor and protect the security and integrity of the Service</li>
            <li>Receive and respond to private questions and privacy requests</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">4. Photo handling</h3>
          <p>Bird identification runs <strong>entirely on your device</strong> using a model the web app downloads once and the iOS app ships with. The photo you identify is <strong>not</strong> transmitted to us or to any third party for identification. We do not use your photos to train AI models. The web app processes selected photos in local browser memory. The iOS share extension may temporarily copy selected photos into the WingDex app group on your device until the app accepts and removes them. To prevent accidental duplicate imports, we store a file fingerprint hash and related metadata such as capture time and location, when present, but not the image contents.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">5. Third-party services</h3>
          <p>WingDex relies on third-party services to deliver its functionality. These services may receive limited data as necessary:</p>
          <ul className="list-disc ml-5 space-y-0.5">
            <li><strong>Cloudflare:</strong> WingDex uses Cloudflare for website delivery, DNS, edge computing, databases, object storage, rate limiting, and operational logging. Cloudflare processes network and request information such as IP address, request URL, user agent, timestamps, and security metadata to provide and protect these services. Its retention varies by data type, configuration, operational need, and legal obligation.</li>
            <li><strong>Wikimedia Foundation:</strong> When WingDex displays Wikipedia descriptions or Wikimedia Commons images, your device may request them directly from Wikimedia. Wikimedia therefore receives the requested species or media URL and ordinary request information such as your IP address, user agent, and timestamp under its own privacy policy.</li>
            <li><strong>eBird / Cornell Lab of Ornithology:</strong> WingDex includes taxonomy and species identifiers derived from eBird/Clements data. Using that bundled data and importing an eBird CSV into WingDex do not contact eBird. If you follow an optional eBird species link, your device contacts eBird and its terms and privacy practices apply.</li>
            <li><strong>BirdLife International:</strong> WingDex provides optional links to species factsheets on BirdLife's DataZone. WingDex does not place your photo or coordinates in those links. If you follow one, your device contacts BirdLife and may disclose ordinary request information such as IP address, user agent, timestamp, and referrer.</li>
            <li><strong>iNaturalist Open Data:</strong> WingDex's identification model was trained using images from the iNaturalist Open Data dataset, and its bundled geographic prior was derived from iNaturalist occurrence records. Identification and prior lookup run locally, so WingDex does not automatically send your photo, coordinates, or identification request to iNaturalist. If you follow an external iNaturalist link, your device contacts that site under its own privacy practices.</li>
            <li><strong>Geoapify:</strong> When you submit a typed place-name search, WingDex's server sends the query and technical API-request information to Geoapify. WingDex does not include your photo, photo coordinates, or WingDex account data in that request, and Geoapify ordinarily sees the server's network address rather than your device's IP address. Geoapify states that it stores request bodies, headers, IP addresses, and timestamps for access control, usage counting, troubleshooting, and service improvement, and that successful-request data is generally retained no longer than 24 hours to produce aggregated usage statistics. Other records may follow different retention requirements under Geoapify's privacy policy.</li>
            <li><strong>OpenStreetMap and Nominatim:</strong> Suggesting an outing name from photo coordinates runs on WingDex infrastructure using a locally hosted database derived from OpenStreetMap data; coordinates are not sent to OpenStreetMap or a third-party geocoding API. The database incorporates Nominatim's published Wikimedia-importance values to rank otherwise similar results. OpenStreetMap data is &copy; OpenStreetMap contributors and available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer" className="underline underline-offset-2">Open Database License (ODbL) 1.0</a>. WingDex publishes its reproducible build method and related notices in <a href="https://github.com/jlian/wingdex/blob/main/scripts/osm-places/build-global.sh" target="_blank" rel="noreferrer" className="underline underline-offset-2">scripts/osm-places/build-global.sh</a>.</li>
            <li><strong>Google Maps:</strong> The web app provides optional links that include an outing's precise coordinates. If you follow one, your device sends those coordinates and ordinary request information to Google Maps under Google's privacy policy.</li>
            <li><strong>Apple MapKit and Apple Maps:</strong> The iOS app uses MapKit to display maps for saved outing coordinates. MapKit may send those coordinates and ordinary device and request information to Apple to provide map content. If you choose to open the location in Apple Maps, WingDex also passes the coordinates and outing name to Apple Maps. Apple's privacy policy applies.</li>
            <li><strong>Social-login providers:</strong> WingDex may offer GitHub, Google, and Apple sign-in. If you choose one, WingDex and that provider exchange a provider-issued account identifier, authentication tokens, and profile fields authorized for login, such as name, email address, and profile image. The provider also learns that you initiated a WingDex sign-in and receives ordinary network and device information. Each provider processes information under its own privacy policy, and you can review or revoke WingDex's access through the provider's account settings.</li>
            <li><strong>Private contact services:</strong> The private contact form linked in Section 12 is hosted separately on Cloudflare. It stores your name, email address, message, user agent, referrer, and submission time in Cloudflare KV, sends your name, email address, and message through Resend for email delivery, and sends a challenge token and your IP address to Cloudflare Turnstile for abuse prevention. Cloudflare and Resend process this information under their own privacy policies.</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">6. Data sharing and disclosure</h3>
          <p>We do not sell, rent, or trade your personal information. We may share information only:</p>
          <ul className="list-disc ml-5 space-y-0.5">
            <li>With Cloudflare and authentication providers as described in Section 5, solely to operate and secure the Service or complete a login you choose</li>
            <li>With Geoapify when you submit a typed location search; location name suggestions from photo coordinates do not involve Geoapify</li>
            <li>With Wikimedia when your device requests species descriptions, images, or image-license information</li>
            <li>With Google Maps when you choose to follow a web map link containing precise outing coordinates</li>
            <li>With Apple when the iOS app uses MapKit to display saved outing coordinates or you choose to open a location in Apple Maps</li>
            <li>With Cloudflare Turnstile and Resend when you submit the private contact form, as described in Section 5</li>
            <li>With a third-party website when you choose to follow an external link</li>
            <li>If required by law, regulation, legal process, or governmental request</li>
            <li>To protect the rights, property, or safety of WingDex, its users, or the public</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">7. Data retention</h3>
          <p>Account and birding records remain in WingDex's live database until you delete the records, delete a registered account, or ask us to remove them. Guest users can delete their birding records in the app, and those records may instead be merged into a registered account when they sign up. When in-app account deletion succeeds, WingDex deletes the live account record and its associated birding data, sessions, passkeys, authentication tokens, linked-provider records, and import receipts. Private contact submissions stored in Cloudflare KV currently have no automatic expiration and remain until manually deleted; Cloudflare Turnstile and Resend may retain their own processing records under their policies. Operational logs, other provider records, and backup data may remain for the retention periods required by the relevant provider's configuration, security, recovery, or legal practices. WingDex does not retain the original eBird CSV after processing or cache Geoapify responses.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">8. Your rights</h3>
          <p>Depending on your jurisdiction, you may have the right to access, correct, delete, or export your personal data, or to object to certain processing. To exercise these rights, contact us as described in Section 12.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">9. Data security</h3>
          <p>We implement reasonable technical and organizational measures to protect your data, including encrypted transport (HTTPS/TLS), secure authentication, and access controls. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">10. Children's privacy</h3>
          <p>WingDex is not directed at children under age 13 (or the applicable age of digital consent in your jurisdiction). We do not knowingly collect personal information from children.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">11. International data transfers</h3>
          <p>WingDex is hosted on globally distributed Cloudflare infrastructure. Cloudflare states that it primarily stores information in the United States and European Economic Area and may process or transfer it elsewhere using the safeguards described in its privacy policy. Your data may therefore be processed in jurisdictions outside your country of residence, which may have different data protection laws.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">12. Changes and contact</h3>
          <p>We may update this policy from time to time. Material changes will be reflected in the "Last updated" date above. For private questions or requests, use the{' '}
            <a href="https://johnlian.net/about/#contact" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground transition-colors">private contact form</a>. For public project questions, open an issue on the{' '}
            <a href="https://github.com/jlian/wingdex/issues" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground transition-colors">WingDex GitHub repository</a>.
          </p>
        </section>
      </article>
    </div>
  )
}
