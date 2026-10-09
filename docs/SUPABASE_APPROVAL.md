# Specific approval request: private sync setup

This is an approval package, **not authority to execute**. The frontend works locally today. Backend changes below have not been applied; actual phone/computer sync and Auth callback code have not passed live tests.

Approve the reviewed migration `supabase/migrations/202610090001_planner_sync_review.sql` **only in project`psdfjframcinoryyklxf` (`personal-trip-planner`)**, creating:

1. Dedicated `planner_private`/`planner_api` schemas; owner-scoped snapshot, persistent deletion-history and file-reservation tables with forced RLS/no direct user writes; five confirmed-owner RPCs for read/CAS commit/reserve/list/release.
2. Private`planner-attachments` bucket,5MiB/file and MIME allowlist;100-object/20MiB owner reservations; restrictive owner/upload/immutable/deletion and bucket-management policies. No public file URLs.
3. Add only`planner_api` to the current exposed API schemas for these RPCs. Keep`planner_private` unexposed, automatic table exposure OFF, and avoid project-wide broad grants.
4. Individual email/password Auth with Confirm email ON, anonymous sign-in OFF, Site URL plus exact confirmation/recovery redirect`https://sfox2006.github.io/Trip-Planner-/`. Users enter all passwords privately. No credentials are copied from other apps. Do not send/claim functioning callbacks before the tested frontend handler exists.
5. Allow user-controlled creation/sign-in of two clearly fictional test accounts and dummy PDF/photo uploads for real Auth/REST/Storage negative testing and later phone/computer sync tests. Only fictional data until checks pass. Remove only separately authorized fictional test artifacts.

This approval does **not** authorize paid upgrades, unrelated project/repo changes, service-role/database/admin keys in frontend/chat, real trip uploads, cloud account erasure or a shared/password-based sync code. Frontend activation with only a publishable key follows successful policy/integration testing and its own reviewed implementation. Documents/SQL are not part of the public app build.

The live root URL is verified200 and PWA publication is complete. Supabase creation settings/tier/region remain user-reported/unverified: no authorized Supabase management connection is available to this agent. The administrator must first inspect the actual project using read-only [SUPABASE_PREFLIGHT.sql](SUPABASE_PREFLIGHT.sql) and dashboard Auth/API/project settings. Stop if project access or state differs, rather than replacing existing resources. Then apply the exact reviewed commit, not a browser-generated alternative schema. Full client and recovery contract: [SUPABASE_SYNC_REVIEW.md](SUPABASE_SYNC_REVIEW.md); passed versus pending evidence: [SUPABASE_VALIDATION.md](SUPABASE_VALIDATION.md).
