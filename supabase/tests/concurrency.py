"""Disposable local PostgreSQL only; no HTTP, credentials or cloud access."""
import concurrent.futures
import json
import subprocess
import sys
import time

container = sys.argv[1] if len(sys.argv) > 1 else 'trip-planner-review-db'
database = sys.argv[2] if len(sys.argv) > 2 else 'planner_review'
owner = '11111111-1111-4111-8111-111111111111'
quota_owner = '55555555-5555-4555-8555-555555555555'
checks = []


def run(sql):
    return subprocess.run(
        ['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', database,
         '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
        input=sql, text=True, capture_output=True, timeout=15)


def auth(sql, subject=owner):
    return f"SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','{subject}',false); " + sql


def check(condition, label):
    if not condition:
        raise AssertionError(label)
    checks.append(label)
    print('PASS: ' + label)


def value(sql):
    result = run(auth(sql))
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip().splitlines()[-1]


def commit(revision, planner, files):
    # Inputs are code-owned fictional JSON with no quotes in identifiers/names.
    return f"SELECT planner_api.commit_document({revision},'{json.dumps(planner)}'::jsonb,'{json.dumps(files)}'::jsonb);"


blank = {'version': 1, 'trips': []}
base_revision = int(value("SELECT planner_api.read_document()->>'revision';"))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    writes = list(executor.map(run, [auth('BEGIN; ' + commit(base_revision, blank, []) +
                                         'SELECT pg_sleep(0.3); COMMIT;')] * 2))
check(sum(r.returncode == 0 for r in writes) == 1 and
      sum('40001' in r.stderr for r in writes) == 1,
      'two concurrent document CAS writes produce one success and one stale conflict')
revision = int(value("SELECT planner_api.read_document()->>'revision';"))
check(revision == base_revision + 1, 'concurrent CAS increments revision exactly once')

object_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
reserve_upload = f"""
SELECT planner_api.reserve_file_object('{object_id}',19,'application/pdf');
INSERT INTO storage.objects(bucket_id,name,metadata) VALUES
 ('planner-attachments','{owner}/{object_id}','{{"size":19,"mimetype":"application/pdf"}}');
"""
assert run(auth(reserve_upload)).returncode == 0
planner = {'version': 1, 'trips': [{'id': 'race-fictional-trip', 'items': [{'id': 'race-fictional-plan'}],
                                  'packing': [], 'expenses': [], 'budgets': [], 'links': []}]}
file = {'version': 1, 'id': 'race-fictional-file', 'tripId': 'race-fictional-trip',
        'planId': 'race-fictional-plan', 'name': 'dummy.pdf', 'type': 'application/pdf',
        'size': 19, 'sha256': 'a' * 64, 'objectId': object_id}
# Hold the same owner lock before publishing so delete starts while the commit
# owns it; VOLATILE helper must see the committed manifest after waiting.
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    publish = executor.submit(run, auth('BEGIN; ' + commit(revision, planner, [file]) +
                                        'SELECT pg_sleep(0.4); COMMIT;'))
    time.sleep(0.12)
    delete = executor.submit(run, auth(f"WITH d AS (DELETE FROM storage.objects WHERE name='{owner}/{object_id}' RETURNING 1) SELECT count(*) FROM d;"))
    published, deleted = publish.result(), delete.result()
check(published.returncode == 0 and deleted.returncode == 0 and deleted.stdout.strip().endswith('0'),
      'concurrent deletion waits for publish and cannot remove newly referenced file')
check(value(f"SELECT count(*) FROM storage.objects WHERE name='{owner}/{object_id}';") == '1',
      'published file metadata remains after deletion race')
revision += 1
assert run(auth(commit(revision, planner, []))).returncode == 0
revision += 1
second_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
assert run(auth(f"SELECT planner_api.reserve_file_object('{second_id}',19,'application/pdf'); INSERT INTO storage.objects(bucket_id,name,metadata) VALUES ('planner-attachments','{owner}/{second_id}','{{\"size\":19,\"mimetype\":\"application/pdf\"}}');")).returncode == 0
second_file = {**file, 'id': 'race-fictional-second-file', 'objectId': second_id}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    delete = executor.submit(run, auth(f"BEGIN; DELETE FROM storage.objects WHERE name='{owner}/{second_id}'; SELECT pg_sleep(0.4); COMMIT;"))
    time.sleep(0.12)
    publish = executor.submit(run, auth(commit(revision, planner, [second_file])))
    deleted, published = delete.result(), publish.result()
check(deleted.returncode == 0 and published.returncode != 0 and '22023' in published.stderr,
      'publish after concurrent orphan deletion rejects missing upload')
check(int(value("SELECT planner_api.read_document()->>'revision';")) == revision,
      'failed missing-file publish preserves prior document revision')
check(value(f"SELECT planner_api.release_file_object('{second_id}');") == 't',
      'removed orphan reservation can be recovered without quota leak')

assert run(f"INSERT INTO auth.users VALUES ('{quota_owner}',now(),false);").returncode == 0
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
    reservations = list(executor.map(run, [auth(
        f"SELECT planner_api.reserve_file_object(md5('concurrent-dummy-{i}')::uuid,5242880,'image/png');", quota_owner)
        for i in range(5)]))
check(sum(r.returncode == 0 for r in reservations) == 4 and
      sum('54000' in r.stderr for r in reservations) == 1,
      'concurrent reservations cannot exceed 20 MiB account quota')
quota = run(auth("SELECT count(*) || ':' || sum(bytes) FROM planner_private.file_objects;", quota_owner))
check(quota.returncode == 0 and quota.stdout.strip().endswith('4:20971520'),
      'four successful concurrent reservations exactly fill quota')
print(json.dumps({'checks': checks, 'result': 'passed', 'scope': 'local PostgreSQL stand-ins only'}, indent=2))
