# Local migration review tests

These files are for a **disposable local PostgreSQL 17 database only**. They are not a deployment workflow. The harness creates minimal `auth` and `storage` stand-ins and fictional UUID subjects without passwords or tokens. It deliberately includes an overly broad existing Storage policy to test the migration's restrictive gates. Never apply the harness or test SQL to Supabase.

The production migration is separately review-only at `../migrations/202610090001_planner_sync_review.sql`. No application or CI job applies it.

Reproduce with Docker (network disabled, no published ports or volumes):

```sh
docker run --name trip-planner-review-db --rm -d --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
docker exec trip-planner-review-db pg_isready
# Wait until ready; then create a fresh database and run each input sequentially.
docker exec trip-planner-review-db createdb -U postgres planner_review
docker exec trip-planner-review-db createdb -U postgres planner_ownership
docker exec -i trip-planner-review-db psql -U postgres -d planner_ownership -v ON_ERROR_STOP=1 < supabase/tests/local-harness.sql
docker exec -i trip-planner-review-db psql -U postgres -d planner_ownership -v ON_ERROR_STOP=1 < supabase/migrations/202610090001_planner_sync_review.sql
docker exec -i trip-planner-review-db psql -U postgres -d planner_ownership -v ON_ERROR_STOP=1 < supabase/tests/ownership.sql
python3 supabase/tests/concurrency.py trip-planner-review-db planner_review
docker stop trip-planner-review-db
```

The local harness verifies SQL parsing, transactions, grants, RLS ownership, anonymous/second-user denials, immutable Storage metadata, CAS conflicts, deletion history and fresh-ID recovery. It does **not** validate Supabase's HTTP endpoints, JWT/email provider, real Storage byte uploads, API exposure, callback handling, signed-in browser state, or phone/computer sync. Those remain mandatory before enabling frontend sync.
