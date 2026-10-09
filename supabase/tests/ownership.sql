-- Local PostgreSQL RLS/RPC checks using fictional subjects. No Auth HTTP/Storage
-- byte API is simulated: live provider integration checks remain separate.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT public.test_assert(planner_api.read_document()->>'revision' = '0', 'new owner gets empty revision zero');
SELECT public.test_assert(planner_api.commit_document(0,
 '{"version":1,"trips":[{"id":"fictional-trip","items":[{"id":"fictional-plan"}],"packing":[{"id":"fictional-pack"}],"expenses":[{"id":"fictional-cost"}],"budgets":[{"id":"fictional-budget"}],"links":[{"id":"fictional-link"}]}]}', '[]')->>'revision' = '1',
 'owner snapshot creates trip/itinerary/cost/packing/budget/link atomically');
SELECT public.test_assert(planner_api.reserve_file_object('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',19,'application/pdf') =
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner reserves an immutable file path');
INSERT INTO storage.objects(bucket_id,name,metadata) VALUES ('planner-attachments',
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '{"size":19,"mimetype":"application/pdf"}');
SELECT public.test_assert((SELECT count(*) FROM storage.objects WHERE bucket_id='planner-attachments')=1,
 'owner may create/list/read own immutable file metadata');
SELECT public.test_assert(planner_api.commit_document(1,
 (planner_api.read_document()->'planner'),
 '[{"version":1,"id":"fictional-file","tripId":"fictional-trip","planId":"fictional-plan","name":"dummy.pdf","type":"application/pdf","size":19,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","objectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]')->>'revision'='2',
 'owner may publish uploaded attachment manifest');
WITH edited AS (UPDATE storage.objects SET metadata='{}' WHERE bucket_id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM edited)=0, 'owner overwrite blocked despite broad pre-existing policy');
WITH removed AS (DELETE FROM storage.objects WHERE bucket_id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM removed)=0, 'referenced file cannot be deleted outside document CAS');
SELECT public.test_error($q$ SELECT planner_api.release_file_object('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$,'22023','referenced or existing file cannot free quota');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name,metadata) VALUES ('planner-attachments','11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{"size":19,"mimetype":"application/pdf"}') $q$,'42501','unreserved upload blocked despite broad policy');
WITH edited AS (UPDATE storage.buckets SET public=true WHERE id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM edited)=0, 'client cannot publish bucket despite broad bucket policy');
WITH removed AS (DELETE FROM storage.buckets WHERE id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM removed)=0, 'client cannot delete protected bucket');
SELECT public.test_error($q$ SELECT planner_api.commit_document(1,'{"version":1,"trips":[]}','[]') $q$,'40001',
 'stale/offline revision cannot overwrite newer state');
SELECT public.test_error($q$ INSERT INTO planner_private.documents(owner_id,revision,planner) VALUES ('22222222-2222-4222-8222-222222222222',1,'{}') $q$,'42501',
 'direct create under another owner denied');
SELECT public.test_error($q$ UPDATE planner_private.documents SET revision=99 WHERE owner_id='11111111-1111-4111-8111-111111111111' $q$,'42501',
 'direct writes cannot bypass CAS even for own records');
SELECT public.test_error($q$ DELETE FROM planner_private.tombstones $q$,'42501', 'direct tombstone deletion denied');

SET ROLE anon;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT public.test_error('SELECT planner_api.read_document()','42501','anonymous document read denied');
SELECT public.test_error($q$ SELECT planner_api.commit_document(0,'{"version":1,"trips":[]}','[]') $q$,'42501','anonymous RPC creation denied');
WITH edited AS (UPDATE storage.buckets SET public=true WHERE id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM edited)=0, 'anonymous caller cannot publish protected bucket');
SELECT public.test_error('SELECT * FROM planner_private.documents','42501','anonymous document listing denied');
-- An anon role cannot even resolve the protected helper/schema; denial is safe.
SELECT public.test_error($q$ SELECT * FROM storage.objects WHERE bucket_id='planner-attachments' $q$,'42501','anonymous file listing/read denied');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name) VALUES ('planner-attachments','11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') $q$,'42501','anonymous file creation denied');
SELECT public.test_error($q$ UPDATE storage.objects SET metadata='{}' WHERE bucket_id='planner-attachments' $q$,'42501','anonymous file alteration denied');
SELECT public.test_error($q$ DELETE FROM storage.objects WHERE bucket_id='planner-attachments' $q$,'42501','anonymous file deletion denied');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
SELECT public.test_assert((SELECT count(*) FROM planner_private.documents)=0,'second user cannot list/read first user records');
SELECT public.test_assert(planner_api.read_document()->>'revision'='0','second user RPC returns own empty document');
SELECT public.test_error($q$ INSERT INTO planner_private.documents(owner_id,revision,planner) VALUES ('11111111-1111-4111-8111-111111111111',1,'{}') $q$,'42501','second user cannot create records under first owner');
SELECT public.test_error('UPDATE planner_private.documents SET revision=99','42501','second user cannot alter first owner records');
SELECT public.test_error('DELETE FROM planner_private.documents','42501','second user cannot delete first owner records');
SELECT public.test_assert((SELECT count(*) FROM storage.objects WHERE bucket_id='planner-attachments')=0,'second user cannot list/read first user files');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name) VALUES ('planner-attachments','11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') $q$,'42501','second user cannot upload under first owner prefix');
WITH edited AS (UPDATE storage.objects SET name='22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' WHERE bucket_id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM edited)=0, 'second user cannot alter/move first user files');
WITH removed AS (DELETE FROM storage.objects WHERE bucket_id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM removed)=0, 'second user cannot delete first user files');
SELECT public.test_error($q$ SELECT planner_api.commit_document(0,'{"version":1,"trips":[],"owner_id":"11111111-1111-4111-8111-111111111111"}','[]') $q$,'22023','client owner injection rejected');
SELECT public.test_assert(planner_api.commit_document(0,'{"version":1,"trips":[]}','[]')->>'revision'='1','second user can create own isolated document');

SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT public.test_assert(planner_api.read_document()->>'revision'='2','first user snapshot/files remain intact after attacks');
SELECT public.test_assert(planner_api.commit_document(2,'{"version":1,"trips":[]}','[]')->>'revision'='3','account reset advances revision, retains row');
SELECT public.test_assert((SELECT count(*) FROM planner_private.tombstones)=7,'deleted trip and all child/file IDs retain tombstones');
SELECT public.test_error($q$ SELECT planner_api.commit_document(3,'{"version":1,"trips":[{"id":"fictional-trip","items":[],"packing":[],"expenses":[],"budgets":[],"links":[]}]}','[]') $q$,'22023','even current-revision client cannot resurrect deleted IDs');
SELECT public.test_assert(planner_api.commit_document(3,'{"version":1,"trips":[{"id":"fresh-fictional-trip","items":[],"packing":[],"expenses":[],"budgets":[],"links":[]}]}','[]')->>'revision'='4','restore with fresh IDs succeeds without clearing deletion history');
SELECT public.test_error($q$ SELECT planner_api.commit_document(NULL,'{"version":1,"trips":[]}','[]') $q$,'22023','missing expected revision rejected');
SELECT public.test_error($q$ SELECT planner_api.commit_document(4,'{"version":2,"trips":[]}','[]') $q$,'22023','unknown planner version rejected');
SELECT public.test_error($q$ SELECT planner_api.commit_document(4,'{"version":1,"trips":[{"id":"duplicate","items":[{"id":"duplicate"}],"packing":[],"expenses":[],"budgets":[],"links":[]}]}','[]') $q$,'22023','duplicate entity IDs rejected');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name) VALUES ('planner-attachments','11111111-1111-4111-8111-111111111111/../dummy.pdf') $q$,'42501','unsafe storage path rejected');
WITH removed AS (DELETE FROM storage.objects WHERE bucket_id='planner-attachments' RETURNING 1) SELECT public.test_assert((SELECT count(*) FROM removed)=1, 'owner may remove orphaned private file');
SELECT public.test_assert(planner_api.release_file_object('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'removed orphan can release quota');

SELECT set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
SELECT public.test_error($q$ SELECT planner_api.commit_document(0,'{"version":1,"trips":[]}','[]') $q$,'42501','unconfirmed account cannot write');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name) VALUES ('planner-attachments','33333333-3333-4333-8333-333333333333/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') $q$,'42501','unconfirmed account cannot upload');
SELECT set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
SELECT public.test_error($q$ SELECT planner_api.commit_document(0,'{"version":1,"trips":[]}','[]') $q$,'42501','anonymous Auth account cannot write despite authenticated role');
RESET ROLE;
SELECT public.test_assert((SELECT public=false AND file_size_limit=5242880 FROM storage.buckets WHERE id='planner-attachments'),'bucket remains private with 5 MiB per-object limit');
SELECT public.test_assert((SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN ('planner_private.documents'::regclass,'planner_private.tombstones'::regclass,'planner_private.file_objects'::regclass)),'RLS forced on every planner table');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
SELECT planner_api.reserve_file_object(md5('fictional-count-' || n)::uuid,1,'image/png') FROM generate_series(1,100) AS s(n);
SELECT public.test_error($q$ SELECT planner_api.reserve_file_object('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'image/png') $q$,'54000','100-object quota includes unuploaded reservations');
SELECT public.test_assert(jsonb_array_length(planner_api.list_file_objects())=100,'owner can enumerate own reservation recovery queue');
SELECT planner_api.release_file_object(object_id) FROM planner_private.file_objects;
SELECT planner_api.reserve_file_object(md5('fictional-byte-' || n)::uuid,5242880,'image/png') FROM generate_series(1,4) AS s(n);
SELECT public.test_error($q$ SELECT planner_api.reserve_file_object('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'image/png') $q$,'54000','20 MiB quota includes staged/orphaned reservations');
SELECT public.test_error($q$ SELECT planner_api.reserve_file_object(md5('fictional-byte-1')::uuid,2,'image/png') $q$,'22023','reservation metadata cannot be changed to evade quotas');
SELECT public.test_error($q$ SELECT planner_api.reserve_file_object('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',5242881,'image/png') $q$,'22023','reservation per-file limit enforced');
SELECT public.test_error($q$ SELECT planner_api.reserve_file_object('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'image/svg+xml') $q$,'22023','active SVG/unsupported file type excluded');
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT public.test_assert(jsonb_array_length(planner_api.list_file_objects())=0,'second owner reservation quota/list is isolated');
SELECT public.test_assert(planner_api.reserve_file_object('cccccccc-cccc-4ccc-8ccc-cccccccccccc',19,'application/pdf') IS NOT NULL,'other owner full quota does not block first owner');
SELECT public.test_error($q$ INSERT INTO storage.objects(bucket_id,name,metadata) VALUES ('planner-attachments','11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc','{"size":18,"mimetype":"application/pdf"}') $q$,'42501','reservation size must match incoming storage metadata');
SELECT public.test_assert(planner_api.release_file_object(md5('fictional-byte-1')::uuid),'releasing absent own ID is idempotent and cannot release other owner reservation');
SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
SELECT public.test_assert(jsonb_array_length(planner_api.list_file_objects())=4,'first user release cannot alter second user reservations');
RESET ROLE;
