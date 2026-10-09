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

## Privacy and storage

**This repository is public. Real travel information must never be committed.** Source, fixtures and the optional demo contain only fictional examples. Enter actual itinerary details privately in the running app, or import your own local backup.

Trips are stored under `personal-trip-planner.v1` in `localStorage`; binary attachments are stored in the `personal-trip-planner-files` IndexedDB database. Both belong to the **same browser profile, device and website origin**. There is no account, backend, cloud storage or automatic cross-device sync. Different hostnames, ports, browsers and devices have separate storage. Anyone with access to that browser profile can read it. Storage is not encrypted by this app. Private browsing and clearing website data may erase it. If planner storage is unavailable/full, text edits remain in memory with a persistent warning and can be downloaded before closing the tab; new attachments and imports containing files require working durable storage. File-storage/quota errors preserve existing plans/files and show a warning. Corrupt stored text is preserved with recovery/reset controls. A stale tab cannot silently overwrite a newer save.

The app uses no analytics, remote fonts, third-party scripts, API calls or personal-data uploads. CSP blocks network connections from scripts. Only opening a user-entered link leaves the app; the linked site has its own privacy policy. Links open with `noopener noreferrer`, and the page sends no referrer. Normal requests for the static app files still reach whichever server hosts them.

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
# Open http://127.0.0.1:8080
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
```

The browser suites start local servers on ports 8093–8095. They use system `/usr/bin/chromium` if present, or Playwright Chromium. Override with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. They write fictional-only screenshots, a PDF and reports to ignored `test-results/`. Tests cover CRUD, storage/reload, filters/date navigation, keyboard access, DST validation, conflicts, backups/import rejection, calendar export, printing, narrow mobile screens, corrupt/unavailable storage and concurrent tabs. File checks cover PDF/photo preview, reload, byte-exact backup/import/download, multi-trip deletion isolation, quota errors and interrupted-import durability. Axe checks cover nine desktop/mobile/empty/dialog states plus attachments and PDF preview. Unit tests cover leap days, DST gaps/folds (including half-hour changes), skipped civil dates, date-line travel, strict imports/file validation, ICS escaping/folding, currency totals and backup identity preservation.

Use a recent browser supporting JavaScript modules, native `<dialog>`, `structuredClone`, `crypto.randomUUID` and `Intl`. Serve from HTTP localhost or HTTPS. Opening the HTML directly via `file://` is not supported. The relative file paths work under a repository subpath. No deployment is configured or authorized by this change.

## First-version limits

- Up to 100 trips, 500 plans per trip and 2,000 packing/expense/budget/link records per list. Total serialized planner data must remain below 2 MB so downloaded backups can be imported. Conflict details are capped at 100 overlapping pairs, with a count of the rest.
- PDF/PNG/JPEG/WebP/GIF only, 5 MiB per file, 20 MiB and 100 attachments total per device/origin; images at most 20 megapixels where browser decoding is available. HTML/SVG and disguised unsupported types are rejected. Full backups are capped at 32 MiB; text remains capped at 2 MB. Browser quotas may be lower. Attachment files and text use separate storage transactions, with staging/rollback to preserve earlier data; they are not an encrypted vault.
- No automatic sync, collaborative editing, cloud recovery, live availability, exchange rates, map embedding or offline app-shell cache. Backups are the transfer/recovery mechanism. Future authenticated sync requires an explicit architecture decision; none is provisioned here.
- Reminders check recorded data only. They cannot verify bookings, travel time between venues, entry requirements, operating hours or whether a transport entry is actually your arrival/departure.
- No recurring activities or drag-and-drop. The form is the reliable editing path. Modifying trip dates never silently deletes records: adjust out-of-range items first.
- Calendar export is a snapshot. Repeated imports or calendar-client UID handling may create duplicates. Delete/replace old calendar imports in your calendar app as needed.

Changes belong on the feature branch and draft PR. Do not merge or deploy without Sam's explicit approval.
