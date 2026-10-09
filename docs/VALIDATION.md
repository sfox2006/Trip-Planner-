# First-version validation

Validated on October 9, 2026 in Node 24.19.0 and system Chromium 151.0.7922.173. All examples and generated artifacts are fictional.

- `npm run format:check`: passed source formatting checks.
- `npm audit --audit-level=high`: no vulnerabilities reported in the development-only toolchain.
- `npm run check`: passed JavaScript syntax checks.
- `npm test`: 17 unit tests passed.
- `npm run test:browser`: 35 browser scenario checks passed, covering real desktop/mobile CRUD, persistence/reload, filter preservation through edits/date changes, keyboard date navigation, safe import/export, ICS, printing, empty states, conflicts, unavailable/corrupt storage and stale-tab protection. The expanded trip-selector checks cover upcoming/past/all/search filters and no-match states on desktop/mobile; switching restores each trip’s own date, section and filters. Costs checks cover paid/planned amounts, zero/decimal values, per-trip/currency isolation, linked costs and deletion without loss or double counting.
- `npm run test:a11y`: no axe WCAG A/AA violations across nine desktop/mobile/empty/section/dialog states; keyboard focus remains inside the editor dialog.
- `git diff --check`: passed.

Visual verification included 1440px desktop, 390px phone and 320px narrow phone layouts. The empty state, populated itinerary, mobile editor, packing, costs, multiple-trip selectors, trip-filter empty states and full printed itinerary were captured and inspected. Generated screenshots/PDF/report live in ignored `test-results/`, and can be reproduced with the browser suite. Automated Chromium checks do not replace testing on actual iOS/Android devices or with every screen reader.

A separate read-only agent reviewed correctness, imports, privacy, timezone behavior, calendar escaping and accessibility. Its reported blockers were fixed and rechecked: repeated conflict time conversion, backup/reload size consistency, pretty-export size mismatch, standalone calendar carriage returns, date-line travel, date-tab focus and independent arrival/departure reminders. Final independent review found no material blocker, verified the 17 unit tests and syntax checks, and checked trip-state/cost isolation plus trip-selection keyboard focus in a real browser.

The reference repository was read without modification, including current GitHub `main` source (`styles.css` blob `d5628cf7a1f4f334c8f1f2647f386a146efa492c`, `app.js` blob `8e544511e9e62558cf31e4fc47ccc59ef8c2013a`). No applicable target/root AGENTS.md or local skills were present. Trip-Planner- was cloned through authorized access; its initial content was one README heading. GitHub metadata confirmed public visibility and authorized push access.

No personal trip data, live accommodation addresses, email links, booking references, QR codes or access credentials were used. The application made no external requests in the instrumented browser scenarios. Source uses no remote assets, analytics or personal-data APIs. Storage is same-browser/same-device localStorage, with local download exports; it is neither encrypted storage nor cloud sync.

Only a feature branch and draft PR are authorized. Merge and deployment remain subject to Sam's explicit approval. The test workflow has no deployment steps. Local checks were run before submission; remote workflow status is reported separately when available.
