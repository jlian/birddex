export default function PrivacyPage() {
  return (
    <div className="px-4 sm:px-6 py-6 space-y-6 max-w-3xl mx-auto">
      <div className="space-y-2">
        <h2 className="font-serif text-2xl font-semibold text-foreground">Privacy Policy</h2>
        <p className="text-sm text-muted-foreground">Last updated: August 2026</p>
      </div>

      <article className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">1. Introduction</h3>
          <p>This Privacy Policy describes how WingDex™ ("we," "us," or "the Service") collects, uses, and shares information when you use the WingDex web application or iOS app. By accessing or using WingDex, you acknowledge that you have read and understood this policy.</p>
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold text-foreground">2. Information we collect</h3>
          <div className="space-y-1">
            <h4 className="font-medium text-foreground">2.1 Information you provide</h4>
            <ul className="list-disc ml-5 space-y-0.5">
              <li><strong>Account information:</strong> Authentication credentials such as passkeys, or information from social login providers (e.g., display name, email address, and provider-issued identifiers).</li>
              <li><strong>Birding data:</strong> Observations, outings, species lists, notes, and related metadata you enter into the app.</li>
              <li><strong>Photos:</strong> Images you add for bird identification are processed entirely on your device. The image itself is never uploaded to us as part of identification; we store only associated metadata (capture time, GPS coordinates if present, file name) and a file fingerprint hash used for duplicate detection.</li>
              <li><strong>Imported data:</strong> Data you import from external sources such as eBird CSV exports.</li>
            </ul>
          </div>
          <div className="space-y-1">
            <h4 className="font-medium text-foreground">2.2 Information collected automatically</h4>
            <ul className="list-disc ml-5 space-y-0.5">
              <li><strong>Usage data:</strong> Basic request metadata (e.g., timestamps, IP addresses, user-agent strings) through hosting infrastructure for operational and security purposes.</li>
              <li><strong>Local storage:</strong> Browser local storage and session cookies to maintain session state and preferences. We do not use third-party tracking or advertising cookies.</li>
            </ul>
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">3. How we use your information</h3>
          <ul className="list-disc ml-5 space-y-0.5">
            <li>Provide, operate, and maintain the WingDex application and its features</li>
            <li>Authenticate your identity and manage your account</li>
            <li>Identify birds from your photos on your device, without uploading the image</li>
            <li>Display species information, media, and related content</li>
            <li>Monitor and protect the security and integrity of the Service</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">4. Photo handling</h3>
          <p>Bird identification runs <strong>entirely on your device</strong> using a model the web app downloads once and the iOS app ships with. The photo you identify is <strong>not</strong> transmitted to us or to any third party for identification, and never leaves your device for that purpose. We do not use your photos to train AI models. To prevent accidental duplicate imports, we store a file fingerprint hash and related metadata (such as capture time and location, when present), but not the image contents.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">5. Third-party services</h3>
          <p>WingDex relies on third-party services to deliver its functionality. These services may receive limited data as necessary:</p>
          <ul className="list-disc ml-5 space-y-0.5">
            <li><strong>Cloudflare:</strong> Hosting, edge computing, DNS, and database infrastructure.</li>
            <li><strong>Wikimedia / Wikipedia:</strong> Species images and descriptions fetched from Wikimedia APIs.</li>
            <li><strong>eBird / Cornell Lab of Ornithology:</strong> Taxonomy and species data for matching and display.</li>
            <li><strong>BirdLife International:</strong> We provide optional links to species factsheets on BirdLife's DataZone. No photo or location data is sent; following a link is your choice.</li>
            <li><strong>iNaturalist:</strong> The identification model and its geographic prior are built from iNaturalist open data. Both ship with the app, so nothing is ever sent to iNaturalist.</li>
            <li><strong>OpenStreetMap Foundation / Nominatim:</strong> WingDex forwards explicitly submitted location searches and rounded coordinates through our server for geocoding. Exact outing and photo coordinates remain stored by WingDex as described above; they are not sent to Nominatim. OpenStreetMap Foundation operates this public service under its own privacy policy and may record API access data and analyze Nominatim queries to operate and improve its services.</li>
            <li><strong>Authentication providers:</strong> Limited profile data exchanged during social login (e.g., GitHub, Apple).</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">6. Data sharing and disclosure</h3>
          <p>We do not sell, rent, or trade your personal information. We may share information only:</p>
          <ul className="list-disc ml-5 space-y-0.5">
            <li>With infrastructure and authentication providers as described in Section 5, solely to operate the Service</li>
            <li>With OpenStreetMap Foundation when you submit a location search or WingDex requests a location suggestion, subject to its separate privacy policy</li>
            <li>If required by law, regulation, legal process, or governmental request</li>
            <li>To protect the rights, property, or safety of WingDex, its users, or the public</li>
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">7. Data retention</h3>
          <p>Your account data and birding records are retained while your account is active. When in-app account deletion succeeds, WingDex deletes the active account record and its associated birding data, sessions, passkeys, and linked-provider records. WingDex caches geocoding provider responses for up to 30 days to reduce repeated requests; expired cache rows are deleted. Hosting providers may retain temporary operational or backup data under their own retention and recovery practices.</p>
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
          <p>WingDex is hosted on globally distributed infrastructure (Cloudflare). Your data may be processed in jurisdictions outside your country of residence, which may have different data protection laws.</p>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">12. Changes and contact</h3>
          <p>We may update this policy from time to time. Material changes will be reflected in the "Last updated" date above. For questions or requests, open an issue on the{' '}
            <a href="https://github.com/jlian/wingdex/issues" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground transition-colors">WingDex GitHub repository</a>.
          </p>
        </section>
      </article>
    </div>
  )
}
