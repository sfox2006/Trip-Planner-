# Disabled private-sync frontend validation

Validated locally on 2026-10-09 with fictional plans, generated images, in-memory Auth/cloud and mocked HTTP. The repository is PUBLIC. No real travel information, real Auth account, key, password or backend write was used.

| Check                                        | Result                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Prettier, JavaScript syntax, diff whitespace | Passed                                                                                                             |
| Unit tests                                   | 45 passed: 21 existing planner/files + 24 sync/provider                                                            |
| Core browser suite                           | 35 passed                                                                                                          |
| PDF/photo browser suite                      | 16 passed, including browser quota failure and original byte recovery                                              |
| Sync browser suite                           | 13 passed, including real IndexedDB v1→v2 migration and cross-store rollback                                       |
| PWA browser suite                            | 12 passed; offline shell/private files/update waiting/data preservation                                            |
| Accessibility                                | 9 existing desktop/mobile states, attachment/PDF states, and 5 new sync dialog states: no WCAG A/AA axe violations |
| Public build                                 | 24 allowlisted files; no test tooling, fixture backups or private exports                                          |
| Independent source review                    | Complete; no remaining material blocker found                                                                      |

The sync suite covers confirmed-account UI (mocked delivery), explicit connection, offline queue/reload, fresh-ID conflict copies, signout/owner-switch refusal, complete recovery exports, missing text/file storage, actual corrupt-text reset, whole attachment database loss, v1 byte preservation and projection quota rollback. The real pinned SDK is exercised against mock fetch for account-switch and signout races. Independent review reproduced and verified fixes for stale authorization, file repair losing pending edits, stale-tab cleanup/missing acknowledged uploads, and storage loss propagating cloud deletion.

Fictional screenshots were generated under ignored `test-results/`: `sync-disabled-mobile.png`, `sync-signin-mobile.png`, `sync-connected-mobile.png`, `sync-conflict-mobile.png`, `sync-recovery-mobile.png`, `sync-connected-desktop.png`, plus the core planner/PWA/files captures. Mobile sign-in/conflict and desktop connected states were visually inspected. Narrow layout/keyboard/focus checks passed; longer dialogs scroll. Reports include `sync-browser-report.json`, existing browser/file/PWA and accessibility results. These files are not in the public deployment allowlist.

Cloud configuration remains disabled, both verification flags are false, and URL/key are empty. Default `connect-src 'none'` remains intact. The private-sync UI did not create an Auth client or make a remote request in the disabled-build test. The SDK is local, exact-version pinned with a lockfile; CI regenerates it and checks byte-exact diff with its dependency licenses.

## Unverified release requirements

These local checks do not establish live Auth settings, email eligibility/delivery, deployed RLS/grants, real Storage REST behavior, two real confirmed-account isolation or physical iOS/Android behavior. No migration/configuration has been applied by this frontend work. The separate approval and live verification scope is in [PRIVATE_SYNC.md](PRIVATE_SYNC.md). Do not enable or wire a key until it is approved and passed.

Browser storage is still same-origin and unencrypted. Connected cloud copies would be plaintext protected by the approved owner RLS/private-bucket policies, readable by privileged provider/project admins; no end-to-end encryption claim is made. Recovery journals retain extra local byte copies and consume browser quota. Account migration/erasure UI, background sync while closed and automatic orphan expiry are not implemented.
