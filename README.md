# Personal Trip Planner

A reusable, mobile-friendly trip planner. Start empty, create a trip, or explore an explicitly fictional coastal-weekend example. The editorial typography, compact date navigation and clear cards take their design cues from [The DC Agenda](https://github.com/sfox2006/DC-Political-events), with a cream, forest green and gold palette.

## What works

- Multiple trips with destination, inclusive date range, destination timezone and notes. The visible trip selector has search and all/upcoming-and-current/past filters. Each trip remembers its own itinerary date, section and search/type/status filters while switching during a session.
- Day tabs, previous/next day and date picker; changing dates scrolls to the top and preserves search/type/status filters. Arrow keys, Home and End navigate date tabs.
- Editable activities, accommodation and transport with local start/end dates and times, per-endpoint timezones, location, notes, suggested/booked status, and booking/ticket links.
- Private PDF/photo attachments on any plan, place, stay or transport card: pick files, preview, download the original, rename or remove. Photos preview locally; PDFs show their first page using the bundled PDF.js renderer, without executing PDF actions or opening embedded links. Download the original for all pages or accessible selectable text. Password-protected or unsupported PDFs may require your own viewer.
- Packing checklist, a prominent Costs section with itemized paid/planned amounts and categories, separate-currency budget limits, and useful links. Optional expense-to-plan links add context without counting the same amount twice. Deleting a plan keeps its costs and detaches the links. Every record can be edited or deleted; deletion asks for confirmation.
- Reminders for missing overnight accommodation, transport on the first/last day, missing locations/booking links, overlapping timed plans and budget overruns. These are planning aids, not a guarantee that logistics are complete. Accommodation is excluded from time overlaps.
- Local JSON backup download, validated import preview and append-only import with fresh IDs. Existing trips are preserved; importing the same backup twice intentionally creates two copies.
- Full-trip calendar (.ics) export and a printable itinerary, including all days regardless of current filters. Print includes packing, expenses and links. Suggested calendar items are tentative; booked items are confirmed. Neither status confirms a reservation with a provider.

## Account testing; private sync remains blocked

This build enables individual email/password account testing with a public Supabase publishable key. **Cloud data sync remains unavailable pending real two-account API/Storage and device verification.** Sign-in, confirmation and password recovery use the exact app root; users enter their own passwords. Both data-sync flags remain false, so trips/files stay in this browser. [Account setup, the data gate and future merge/recovery behavior](docs/PRIVATE_SYNC.md) and [the staged live checklist](docs/PRIVATE_SYNC_LIVE_CHECKLIST.md) describe the remaining checks.

## Privacy and storage

**This repository is public. Real travel information must never be committed.** Source, fixtures and the optional demo contain only fictional examples. Enter actual itinerary details privately in the running app, or import your own local backup.

Trips are stored under `personal-trip-planner.v1` in `localStorage`; binary attachments are stored in the `personal-trip-planner-files` IndexedDB database. Both belong to the **same browser profile, device and website origin**. Optional account authentication is available for testing; cloud trip/file storage and automatic cross-device sync remain blocked. Different hostnames, ports, browsers and devices have separate storage. Anyone with access to that browser profile can read it. Storage is not encrypted by this app. Private browsing and clearing website data may erase it. If planner storage is unavailable/full, text edits remain in memory with a persistent warning and can be downloaded before closing the tab; new attachments and imports containing files require working durable storage. File-storage/quota errors preserve existing plans/files and show a warning. Corrupt stored text is preserved with recovery/reset controls. A stale tab cannot silently overwrite a newer save.

The app uses no analytics, remote fonts, runtime CDN scripts or trip/file uploads. Its locally bundled Auth client can contact only the dedicated Supabase origin; CSP blocks other script connection origins. Account authentication sends email/password/session data to Supabase only through Auth endpoints. Planner and Storage requests are blocked in this release. Only opening a user-entered link leaves the app; the linked site has its own privacy policy. Links open with `noopener noreferrer`, and the page sends no referrer. Normal requests for the static app files still reach whichever server hosts them.

On GitHub Pages, the app is publicly accessible even if its source repository becomes private. Visitors do not receive your entered trips or uploaded files: those stay in your browser. Browser storage is isolated by origin, not URL path; other websites served at `https://sfox2006.github.io` share that origin and their scripts can access its localStorage/IndexedDB. Signing in does not turn local browser storage into an authenticated or encrypted vault. Use only trusted sites on that origin and keep private backups.

Full JSON backups include original attachment bytes, planner text and ownership links. Import validates all fields, file types/signatures, sizes and references, then creates independent copies; it also accepts earlier text-only backups. An explicitly labeled text-only export remains available if file storage is unavailable and excludes all attachment bytes. Deleting a trip/plan removes its owned attachments; recent staged files from an interrupted import are protected for ten minutes before later startup cleanup. Save regular complete backups.

JSON backups, calendar files and printed/PDF itineraries contain private information, potentially including booking or ticket access URLs and uploaded tickets/photos. Exports stay local until you choose to share them. Keep them safe. Do not store them, real addresses, email links, booking references, ticket QR codes or credentials in Git, issue/PR text or public assets. Git ignores the default backup/recovery/calendar export names and `*.private.json`, but that is not a substitute for checking what you stage. There are no paid integrations, bookings or external messaging.

## Dates, timezones and money

Trip dates are civil dates, independent of the device timezone. Dates range from 1900–2100, with at most 366 days per trip. Each timed plan uses explicit start and end IANA timezones; both endpoints must be entered. Overnight and date-line transport are supported, including an arrival on an earlier local date when its actual instant follows departure. Items appear on the inclusive range of their recorded local endpoint dates. Times and endpoint timezone names are displayed as entered, rather than silently converting them to the device's timezone.

Spring DST times that do not exist are rejected. When autumn clock changes repeat a time, the form lets you choose its first or second occurrence independently at each endpoint. Calendar exports use UTC instants. Unscheduled plans export as all-day events with exclusive end dates; accommodation ends at its checkout date. Stay reminders count nights before checkout. Timed overlap detection uses actual instants across timezones. Timezone rules come from the browser's `Intl` database; keep your browser up to date.

Amounts must use a valid three-letter currency code and that currency's decimal precision. Budget limits in the same currency are added; paid and planned costs are shown separately for each currency, with their combined trip total compared against the budget. **No currency conversion or exchange rates are invented.** Record costs in the currency actually charged or planned. There is no payment or banking integration.

## Run and check locally

A static website with no framework, build step or server database. The browser-ready PDF.js 6.4.299 modules are bundled under `vendor/` with their Apache-2.0 license; no CDN is used. See [vendor/README.md](vendor/README.md) for provenance and updating.

```sh
npm start
# Local source/UI editing: http://127.0.0.1:8080
# Auth testing requires the packaged CSP:
npm run build
npm run preview
npm run check
npm test
```

For browser tests, Python 3 and a Chromium browser are required:

```sh
npm ci
npx playwright install chromium   # if no system Chromium is installed
npm run test:browser
npm run test:files
npm run test:a11y
npm run test:sync
npm run test:auth
npm run test:pwa
```

The browser suites start local servers on ports 8093–8095, 8097, 8100 and 8101. They use system `/usr/bin/chromium` if present, or Playwright Chromium. Override with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. They write fictional-only screenshots, a PDF and reports to ignored `test-results/`. Tests cover CRUD, storage/reload, filters/date navigation, keyboard access, DST validation, conflicts, backups/import rejection, calendar export, printing, narrow mobile screens, corrupt/unavailable storage and concurrent tabs. File checks cover PDF/photo preview, reload, byte-exact backup/import/download, multi-trip deletion isolation, quota errors and interrupted-import durability. Axe checks cover nine desktop/mobile/empty/dialog states plus attachments and PDF preview. Unit tests cover leap days, DST gaps/folds (including half-hour changes), skipped civil dates, date-line travel, strict imports/file validation, ICS escaping/folding, currency totals and backup identity preservation.

Use a recent browser supporting JavaScript modules, native `<dialog>`, `structuredClone`, `crypto.randomUUID` and `Intl`. Serve from HTTP localhost or HTTPS. Opening the HTML directly via `file://` is not supported. The relative file paths work under a repository subpath.

## GitHub Pages publication

Sam authorized GitHub Pages publication of this local-first version. The manually dispatched `Publish Personal Trip Planner` workflow accepts `main` only, reruns the repository checks, and publishes an explicit allowlist of runtime files. Tests, screenshots, backups and repository tooling are excluded. The deployment job uses only `pages: write` and `id-token: write`; the build job has read access. Pages source must be set to GitHub Actions, with a `github-pages` deployment environment restricted to `main`. Publishing the app does not synchronize trip data. Sam separately approved the dedicated backend and Auth-only deployment; actual data sync remains gated on live verification.

The smallest manual setup is Settings → Pages → Source: GitHub Actions; Settings → Environments → `github-pages` → Deployment branches and tags: Selected branches and tags → add a Branch rule for `main`; then Actions → Publish Personal Trip Planner → Run workflow → `main`. A referenced environment is automatically created by GitHub if absent, but a custom workflow does not automatically add its main-only protection rule. Configure that restriction before the first run. No deployment secret, custom domain or paid upgrade is needed for this public repository. GitHub's Pages and environment configuration requires appropriate administrator integration access; this implementation does not bypass denied settings.

## Add to your phone and use offline

Choose **Add to home screen** near the bottom of the planner. On iPhone/iPad, open in Safari and choose Share → Add to Home Screen → Add. On supported Android browsers, the dialog offers the native Install app prompt when available; otherwise use Chrome's menu → Install app/Add to Home screen. Browser wording and installation support vary. The installed app uses the original compass icon and standalone display.

Download a complete backup before installing. Safari and iOS home-screen apps may have different storage; if the new app starts empty, import the backup there. Installation does not copy data automatically, synchronize devices or create an account. Actual iOS/Android installation/storage behavior still needs device testing.

Wait for **Offline copy ready** before relying on offline reopening. The service worker is scoped to the app's project path and caches only the public app shell, including its local PDF renderer; trip data and file blobs remain in localStorage/IndexedDB. It never caches uploaded attachments, backups or remote APIs. Device online/offline status describes the browser's network indication, not proof of internet availability or cloud synchronization. Browser cache/storage eviction can remove offline availability.

Updates download a complete hash-verified shell into a separate cache. An inconsistent or failed download preserves the previous working copy. Updates wait until all planner tabs and home-screen windows close; reopening then applies the new release. Open forms are never force-reloaded. Saved data schema/keys remain unchanged. Cache cleanup touches only this app's scoped shell caches. Keep backups before updates; never clear website data merely to update.

The offline release is packaged with `npm run build`; `npm run preview` serves the generated `_site/`. `npm start` serves editable source without registering an offline worker, so development changes remain immediately visible. GitHub Pages publication uses the packaged build. No framework or personal data is involved in packaging.

## First-version limits

- Up to 100 trips, 500 plans per trip and 2,000 packing/expense/budget/link records per list. Total serialized planner data must remain below 2 MB so downloaded backups can be imported. Conflict details are capped at 100 overlapping pairs, with a count of the rest.
- PDF/PNG/JPEG/WebP/GIF only, 5 MiB per file, 20 MiB and 100 attachments total per device/origin; images at most 20 megapixels where browser decoding is available. HTML/SVG and disguised unsupported types are rejected. Full backups are capped at 32 MiB; text remains capped at 2 MB. Browser quotas may be lower. Attachment files and text use separate storage transactions, with staging/rollback to preserve earlier data; they are not an encrypted vault.
- This build has no enabled automatic sync/cloud recovery, collaborative editing, live availability, exchange rates or map embedding. Local backups remain the transfer/recovery mechanism. The optional Auth/sync code is disabled pending separate backend approval and live verification.
- Reminders check recorded data only. They cannot verify bookings, travel time between venues, entry requirements, operating hours or whether a transport entry is actually your arrival/departure.
- No recurring activities or drag-and-drop. The form is the reliable editing path. Modifying trip dates never silently deletes records: adjust out-of-range items first.
- Calendar export is a snapshot. Repeated imports or calendar-client UID handling may create duplicates. Delete/replace old calendar imports in your calendar app as needed.

Changes belong on the feature branch and draft PR. Do not merge or deploy without Sam's explicit approval.
