# Staged live verification — Personal Trip Planner

This is a plan, not a passed-test record. Limit all work to `sfox2006/Trip-Planner-` and Supabase `psdfjframcinoryyklxf`. Never reapply `supabase/migrations/202610090001_planner_sync_review.sql`: the exact migration is already recorded as `20261009093623_planner_sync_review`. The handoff reports 55 hosted rollback-only SQL-role assertions passing and no retained fixtures; those do not establish JWT/HTTP/file-byte behavior.

## 1. Publish account testing with private sync blocked

The parent supplied the existing enabled modern publishable key after checking the approved settings and SQL-policy preconditions. Auth-only config is now wired in source; the schema below shows its fields with the actual public key omitted. Use exactly these five fields in `cloud-config.js`:

```js
export const cloudConfig = Object.freeze({
  authEnabled: true,
  enabled: false,
  policiesVerified: false,
  projectUrl: "https://psdfjframcinoryyklxf.supabase.co",
  publishableKey: "<enabled sb_publishable_... key supplied by parent>",
});
```

The placeholder is intentionally invalid. Never insert a legacy JWT/anon, service-role or secret key. `npm run build` derives `connect-src https://psdfjframcinoryyklxf.supabase.co`; no other network origin is needed. The locally bundled SDK version remains pinned. Run all repository CI checks on the exact config head, merge approved ready code, dispatch the existing main-only Pages workflow, and verify deployed bytes, CSP, root callback path and service-worker update. Private sync stays blocked at UI, provider and request levels.

User step: on the deployed root, open **Private sync**, enter your own email/password, choose **Create account**, then open the confirmation email in the browser that requested it. No agent enters or generates a password. Use the exact root `https://sfox2006.github.io/Trip-Planner-/` for Site URL and redirect. Sign in, sign out, reload, test session-only versus explicitly remembered login, and use **Reset password** with a privately entered replacement. Record callback success, expired/wrong-browser refusal, URL parameter removal and preservation of local plans. Confirm only `/auth/v1/` traffic occurs: no `/rest/v1/` or `/storage/v1/`, preview, journal binding, or background sync.

Two distinct real confirmed accounts are mandatory. Currently only one eligible team email is known. Supabase default SMTP delivers only to project-team addresses and is currently limited to two messages/hour. The parent/user must resolve a second eligible address and delivery path; this work does not authorize organization membership changes, SMTP provisioning, paid upgrades, manual confirmation or confirmation bypass. Do not trigger emails without the user's action. Confirmation and recovery can consume the small mail budget; space user actions accordingly.

References: [password Auth and PKCE](https://supabase.com/docs/guides/auth/passwords), [default SMTP restrictions](https://supabase.com/docs/guides/auth/auth-smtp), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## 2. Verify real JWT, REST and Storage with fictional fixtures

After two distinct confirmed users A/B are available, the parent coordinates session handling in private browser contexts. Keep JWTs in memory and redact response bodies/headers from public evidence. The publishable key is not an authenticated user's JWT. Also test no session and invalid/expired JWT. Before the user confirms the second account, verify that password sign-in is refused and supplies no authenticated session; keep confirmation enabled and do not manufacture an unconfirmed JWT or create an extra account just for this test. Do not silently substitute mocked or SQL-role identities for any case.

Expose only `planner_api` using the supported Data API settings route. Leave `planner_private` unexposed and default public-table auto-exposure off. Preserve the exact migration's narrow grants; do not copy the general documentation's `GRANT ALL` example. If unrelated schemas are already exposed, review the dedicated project's approved scope before changing their exposure. Verify the effective HTTP result, not only the dashboard save. See [custom schema exposure](https://supabase.com/docs/guides/api/using-custom-schemas).

Use `/rest/v1/rpc/<name>` with `Content-Profile: planner_api`, the publishable `apikey` and each user's actual Bearer JWT. The five approved RPCs are `read_document`, `commit_document`, `reserve_file_object`, `list_file_objects`, `release_file_object`. Use only a clearly fictional itinerary and small valid PNG/PDF fixture; keep a known SHA-256 of its original bytes.

| Check | Required outcome |
| --- | --- |
| A/B `read_document` and `list_file_objects` | Each sees only its own independent document/reservations; no A details appear for B. |
| A `commit_document` (`p_expected_revision`, `p_planner`, `p_files`) then B reads | B cannot retrieve/change A's document. Returned decimal revision matches readback. |
| Anonymous, invalid/expired JWT, unconfirmed user | Cannot execute planner RPCs, reserve files or obtain private bytes; errors/empty responses must contain no owner's data. |
| Direct tables/helper functions | `planner_private.documents`, `tombstones`, `file_objects` and private helpers are unavailable through exposed API; no direct write path exists. |
| A `reserve_file_object` (`p_object_id`, `p_bytes`, `p_mime_type`) | Returns exactly A UUID/object UUID. Foreign owner paths and unreserved uploads fail. |
| Immutable A upload/download under `planner-attachments/A_UUID/object_UUID` | Original bytes/hash/MIME match; overwrite/upsert fails. B and unauthenticated list/download/update/delete and public-object URL cannot expose A bytes. |
| MIME, 5 MiB/object, 20 MiB/100-object quota | Invalid MIME/metadata/path, oversize objects, reservation mismatch and quota excess fail. Reservations/orphans count toward quota. |
| CAS and tombstones | Stale revision fails; concurrent commits cannot overwrite; deletion versus stale/offline edit preserves tombstone and requires a fresh-ID copy. |
| Reference/delete races | Referenced object cannot be deleted or reservation released; concurrent reference/delete cannot leave an accepted manifest pointing to deleted bytes. |
| Missing bytes/recovery | Interrupted/lost upload acknowledgement retries from originals; missing/corrupt referenced bytes repair under fresh object IDs without losing competing/pending edits. |
| Unrelated bucket nonregression | Verify only if a real unrelated test bucket exists and its test is authorized; absence means not applicable, not a fabricated pass. |

A failed API exposure check (for example an unknown schema) is a configuration blocker, not proof of owner isolation. Similarly an empty successful Storage delete/list response does not prove authorization by itself: re-read A's original object and confirm its hash/continued existence. Capture status, safe error code, boolean/hash comparison and test identity label only. Clean up fictional documents/objects through the approved owner APIs after recording results; verify residual reservations/tombstones and explicitly report any retained fixtures.

## 3. Release private sync, then test two devices

Only after the real negative/API/byte test record passes may a separate reviewed config commit set `authEnabled: true`, `enabled: true`, `policiesVerified: true` with the same exact URL/publishable key. Repeat repository checks, main Pages deployment and deployed-byte/CSP verification.

Use empty isolated phone/computer profiles and the same confirmed user A. Create a fictional trip and a tiny valid attachment, explicitly **Connect and merge** on each, verify exact file bytes, edit independent fields, make competing offline notes, reload while offline, reconnect and choose conflict copies. Test signout/account switch to B, file check/repair and failed-request recovery. Account B must not receive A's device copy or private bytes. Check real iOS/Android installation, background/resume and storage behavior on the user's devices.

Real private import remains blocked until all required live tests pass. The user's Library import is separate and unavailable here. Obtain that import only through the parent's private workflow after verification; never commit its contents or tickets to this public repo.
