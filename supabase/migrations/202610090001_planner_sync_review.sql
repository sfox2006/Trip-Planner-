-- REVIEW ONLY. No application or workflow executes this file.
-- Intended project: personal-trip-planner / psdfjframcinoryyklxf.
-- Requires separate approval before applying, exposing planner_api, or changing Auth.
-- Run once as the project database administrator in a fresh/dedicated project.
BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL OR to_regclass('storage.objects') IS NULL
     OR to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'Supabase auth/storage prerequisites are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('planner_private','planner_api'))
     OR EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'planner-attachments') THEN
    RAISE EXCEPTION 'Planner resources already exist: inspect rather than replace';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.buckets'::regclass) THEN
    RAISE EXCEPTION 'Storage objects/buckets RLS must already be enabled';
  END IF;
END $$;

CREATE SCHEMA planner_private;
CREATE SCHEMA planner_api;
REVOKE ALL ON SCHEMA planner_private, planner_api FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA planner_private, planner_api TO authenticated;
-- Do not change project-wide default privileges or expose any schema here.

-- Account-wide atomic snapshot: the existing validated v1 planner includes trips,
-- activity/accommodation/transport, costs/budgets, packing and useful links.
CREATE TABLE planner_private.documents (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  planner jsonb NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(planner) = 'object'),
  CHECK (octet_length(planner::text) <= 2097152),
  CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 100)
);
-- Retain deletions indefinitely. Restoring a deleted entity requires a new ID.
CREATE TABLE planner_private.tombstones (
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id text NOT NULL CHECK (entity_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  deleted_revision bigint NOT NULL CHECK (deleted_revision > 0),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, entity_id)
);
-- Includes staged and orphaned uploads in quota; no automatic expiry can free
-- quota while bytes remain. Release is a reviewed RPC after private removal.
CREATE TABLE planner_private.file_objects (
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','image/webp','image/gif')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, object_id)
);
ALTER TABLE planner_private.file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_private.file_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE planner_private.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_private.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE planner_private.tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_private.tombstones FORCE ROW LEVEL SECURITY;
REVOKE ALL ON planner_private.documents, planner_private.tombstones, planner_private.file_objects FROM PUBLIC, anon, authenticated;
GRANT SELECT ON planner_private.documents, planner_private.tombstones, planner_private.file_objects TO authenticated;

-- Explicit confirmed individual email account; anonymous Auth accounts excluded.
-- auth.uid() is supplied by the validated Supabase JWT, never a client parameter.
CREATE FUNCTION planner_private.confirmed_owner() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id FROM auth.users AS u
  WHERE u.id = (SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
    AND NOT coalesce(u.is_anonymous, false)
$$;
REVOKE ALL ON FUNCTION planner_private.confirmed_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_private.confirmed_owner() TO authenticated;
CREATE POLICY documents_owner_read ON planner_private.documents FOR SELECT TO authenticated
  USING (owner_id = (SELECT planner_private.confirmed_owner()));
CREATE POLICY tombstones_owner_read ON planner_private.tombstones FOR SELECT TO authenticated
  USING (owner_id = (SELECT planner_private.confirmed_owner()));
CREATE POLICY file_objects_owner_read ON planner_private.file_objects FOR SELECT TO authenticated
  USING (owner_id = (SELECT planner_private.confirmed_owner()));
-- No direct INSERT/UPDATE/DELETE grants or policies. Reviewed RPCs are the only writers.

-- Bounded transport shape / global IDs / attachment references. Client must also
-- run model.validate(), safeURL/filename and byte-signature checks on every read.
CREATE FUNCTION planner_private.entity_ids(p_planner jsonb, p_files jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  t jsonb; e jsonb; f jsonb; collection text; identifier text;
  ids text[] := ARRAY[]::text[]; total_bytes bigint := 0;
BEGIN
  IF p_planner IS NULL OR jsonb_typeof(p_planner) <> 'object'
     OR p_planner->'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(p_planner->'trips') IS DISTINCT FROM 'array'
     OR (SELECT count(*) FROM jsonb_object_keys(p_planner)) <> 2
     OR octet_length(p_planner::text) > 2097152
     OR jsonb_array_length(p_planner->'trips') > 100
     OR p_files IS NULL OR jsonb_typeof(p_files) <> 'array'
     OR jsonb_array_length(p_files) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid or oversized planner envelope';
  END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(p_planner->'trips') LOOP
    IF jsonb_typeof(t) <> 'object' OR jsonb_typeof(t->'id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid trip';
    END IF;
    ids := array_append(ids, t->>'id');
    FOREACH collection IN ARRAY ARRAY['items','packing','expenses','budgets','links'] LOOP
      IF jsonb_typeof(t->collection) IS DISTINCT FROM 'array'
         OR jsonb_array_length(t->collection) > (CASE WHEN collection = 'items' THEN 500 ELSE 2000 END) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid trip collection';
      END IF;
      FOR e IN SELECT value FROM jsonb_array_elements(t->collection) LOOP
        IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid entity';
        END IF;
        ids := array_append(ids, e->>'id');
      END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(p_files) LOOP
    IF jsonb_typeof(f) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(f)) <> 9
       OR NOT f ?& ARRAY['id','tripId','planId','name','type','size','sha256','objectId','version']
       OR f->'version' IS DISTINCT FROM '1'::jsonb
       OR jsonb_typeof(f->'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'tripId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'planId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'type') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'sha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'objectId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'size') IS DISTINCT FROM 'number'
       OR (f->>'objectId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (f->>'sha256') !~ '^[0-9a-f]{64}$'
       OR (f->>'size') !~ '^[1-9][0-9]{0,6}$'
       OR (f->>'size')::bigint > 5242880
       OR length(f->>'name') NOT BETWEEN 1 AND 140
       OR (f->>'name') ~ '[[:cntrl:]/\\]'
       OR (f->>'type') NOT IN ('application/pdf','image/png','image/jpeg','image/webp','image/gif')
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_planner->'trips') AS trip(value)
         WHERE trip.value->>'id' = f->>'tripId' AND (
           EXISTS (
             SELECT 1 FROM jsonb_array_elements(trip.value->'items') AS item(value)
             WHERE item.value->>'id' = f->>'planId'
           )
         )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid attachment manifest';
    END IF;
    ids := array_append(ids, f->>'id');
    total_bytes := total_bytes + (f->>'size')::bigint;
  END LOOP;
  IF total_bytes > 20971520 OR EXISTS (
    SELECT 1 FROM unnest(ids) AS entry(id)
    WHERE id IS NULL OR id !~ '^[A-Za-z0-9_-]{1,100}$'
  ) OR cardinality(ids) <> (SELECT count(DISTINCT id) FROM unnest(ids) AS entry(id))
    OR jsonb_array_length(p_files) <> (
      SELECT count(DISTINCT value->>'objectId') FROM jsonb_array_elements(p_files)
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid/duplicate IDs or attachment total';
  END IF;
  RETURN ids;
END $$;
REVOKE ALL ON FUNCTION planner_private.entity_ids(jsonb,jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION planner_api.read_document() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE actor uuid := planner_private.confirmed_owner(); result jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirmed individual account required'; END IF;
  SELECT jsonb_build_object('revision', d.revision::text, 'planner', d.planner,
    'files', d.files, 'updatedAt', d.updated_at,
    'deletedIds', coalesce((SELECT jsonb_agg(t.entity_id ORDER BY t.entity_id)
      FROM planner_private.tombstones AS t WHERE t.owner_id = actor), '[]'::jsonb))
  INTO result FROM planner_private.documents AS d WHERE d.owner_id = actor;
  RETURN coalesce(result, jsonb_build_object('revision','0','planner',jsonb_build_object('version',1,'trips','[]'::jsonb),
    'files','[]'::jsonb,'updatedAt',NULL,'deletedIds','[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION planner_api.read_document() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_api.read_document() TO authenticated;

CREATE FUNCTION planner_api.commit_document(
  p_expected_revision bigint, p_planner jsonb, p_files jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := planner_private.confirmed_owner();
  previous planner_private.documents%ROWTYPE;
  new_ids text[]; old_ids text[]; next_revision bigint;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Confirmed individual account required';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Expected revision required';
  END IF;
  new_ids := planner_private.entity_ids(p_planner, p_files);
  -- Serializes concurrent first creation, commits and reset for this owner.
  PERFORM pg_advisory_xact_lock(hashtextextended('planner:' || actor::text, 0));
  SELECT * INTO previous FROM planner_private.documents WHERE owner_id = actor FOR UPDATE;
  IF coalesce(previous.revision, 0) <> p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Revision conflict: preserve local edits and resolve';
  END IF;
  IF EXISTS (SELECT 1 FROM planner_private.tombstones
             WHERE owner_id = actor AND entity_id = ANY(new_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Deleted ID cannot be resurrected; restore with fresh IDs';
  END IF;
  -- Storage API upload must succeed before publishing metadata. Size/MIME are
  -- checked here; client independently verifies downloaded SHA-256/signatures.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_files) AS f(value)
    WHERE NOT EXISTS (
      SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'planner-attachments'
        AND o.name = actor::text || '/' || (f.value->>'objectId')
        AND o.metadata->>'mimetype' = f.value->>'type'
        AND (o.metadata->>'size')::bigint = (f.value->>'size')::bigint
        AND EXISTS (SELECT 1 FROM planner_private.file_objects AS r
          WHERE r.owner_id = actor AND r.object_id = (f.value->>'objectId')::uuid
            AND r.bytes = (f.value->>'size')::integer AND r.mime_type = f.value->>'type')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Attachment upload missing or metadata mismatch';
  END IF;
  next_revision := coalesce(previous.revision, 0) + 1;
  old_ids := CASE WHEN previous.revision IS NULL THEN ARRAY[]::text[]
                 ELSE planner_private.entity_ids(previous.planner, previous.files) END;
  IF (SELECT count(*) FROM planner_private.tombstones WHERE owner_id = actor)
      + (SELECT count(*) FROM unnest(old_ids) AS e(id) WHERE NOT (id = ANY(new_ids))) > 100000 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'Deletion history limit reached; request reviewed maintenance';
  END IF;
  INSERT INTO planner_private.tombstones(owner_id, entity_id, deleted_revision)
    SELECT actor, id, next_revision FROM unnest(old_ids) AS e(id) WHERE NOT (id = ANY(new_ids))
    ON CONFLICT (owner_id, entity_id) DO NOTHING;
  INSERT INTO planner_private.documents(owner_id, revision, planner, files, updated_at)
    VALUES (actor, next_revision, p_planner, p_files, now())
    ON CONFLICT (owner_id) DO UPDATE SET revision = EXCLUDED.revision,
      planner = EXCLUDED.planner, files = EXCLUDED.files, updated_at = EXCLUDED.updated_at;
  RETURN jsonb_build_object('revision', next_revision::text);
END $$;
REVOKE ALL ON FUNCTION planner_api.commit_document(bigint,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_api.commit_document(bigint,jsonb,jsonb) TO authenticated;

CREATE FUNCTION planner_api.reserve_file_object(p_object_id uuid, p_bytes integer, p_mime_type text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := planner_private.confirmed_owner(); reserved planner_private.file_objects%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirmed individual account required'; END IF;
  IF p_object_id IS NULL OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 5242880
     OR p_mime_type IS NULL OR p_mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp','image/gif') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid attachment reservation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('planner:' || actor::text, 0));
  SELECT * INTO reserved FROM planner_private.file_objects WHERE owner_id=actor AND object_id=p_object_id;
  IF reserved.object_id IS NOT NULL THEN
    IF reserved.bytes <> p_bytes OR reserved.mime_type <> p_mime_type THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Existing reservation is immutable';
    END IF;
    RETURN actor::text || '/' || p_object_id::text;
  END IF;
  IF (SELECT count(*) FROM planner_private.file_objects WHERE owner_id=actor) >= 100
     OR coalesce((SELECT sum(bytes) FROM planner_private.file_objects WHERE owner_id=actor),0) + p_bytes > 20971520 THEN
    RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='File quota includes staged/orphaned files; recover or remove them first';
  END IF;
  INSERT INTO planner_private.file_objects(owner_id,object_id,bytes,mime_type) VALUES(actor,p_object_id,p_bytes,p_mime_type);
  RETURN actor::text || '/' || p_object_id::text;
END $$;
REVOKE ALL ON FUNCTION planner_api.reserve_file_object(uuid,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_api.reserve_file_object(uuid,integer,text) TO authenticated;

CREATE FUNCTION planner_api.list_file_objects() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('objectId',object_id,'size',bytes,'type',mime_type,'createdAt',created_at) ORDER BY created_at),'[]'::jsonb)
  FROM planner_private.file_objects WHERE owner_id=(SELECT planner_private.confirmed_owner())
$$;
REVOKE ALL ON FUNCTION planner_api.list_file_objects() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_api.list_file_objects() TO authenticated;

CREATE FUNCTION planner_api.release_file_object(p_object_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := planner_private.confirmed_owner();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirmed individual account required'; END IF;
  IF p_object_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Object ID required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('planner:' || actor::text, 0));
  IF EXISTS (SELECT 1 FROM planner_private.documents AS d, jsonb_array_elements(d.files) AS f(value)
             WHERE d.owner_id=actor AND f.value->>'objectId'=p_object_id::text)
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='planner-attachments' AND name=actor::text || '/' || p_object_id::text) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Remove manifest reference and Storage object before releasing quota';
  END IF;
  DELETE FROM planner_private.file_objects WHERE owner_id=actor AND object_id=p_object_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION planner_api.release_file_object(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_api.release_file_object(uuid) TO authenticated;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('planner-attachments','planner-attachments',false,5242880,
 ARRAY['application/pdf','image/png','image/jpeg','image/webp','image/gif']);

CREATE FUNCTION planner_private.owns_object(object_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(
    split_part(object_name,'/',1) = (SELECT planner_private.confirmed_owner())::text
    AND object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;
REVOKE ALL ON FUNCTION planner_private.owns_object(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_private.owns_object(text) TO authenticated;
CREATE FUNCTION planner_private.can_upload_object(object_name text, object_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := planner_private.confirmed_owner();
BEGIN
  IF actor IS NULL OR NOT planner_private.owns_object(object_name) THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('planner:' || actor::text, 0));
  RETURN EXISTS (SELECT 1 FROM planner_private.file_objects AS r
    WHERE r.owner_id=actor AND r.object_id=split_part(object_name,'/',2)::uuid
      AND object_metadata->>'mimetype'=r.mime_type AND object_metadata->>'size'=r.bytes::text);
END $$;
CREATE FUNCTION planner_private.can_delete_object(object_name text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := planner_private.confirmed_owner();
BEGIN
  IF actor IS NULL OR NOT planner_private.owns_object(object_name) THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('planner:' || actor::text, 0));
  RETURN NOT EXISTS (SELECT 1 FROM planner_private.documents AS d, jsonb_array_elements(d.files) AS f(value)
    WHERE d.owner_id=actor AND actor::text || '/' || (f.value->>'objectId')=object_name);
END $$;
REVOKE ALL ON FUNCTION planner_private.can_upload_object(text,jsonb), planner_private.can_delete_object(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION planner_private.can_upload_object(text,jsonb), planner_private.can_delete_object(text) TO authenticated;

-- Unprivileged callers cannot make our bucket public or weaken its limits,
-- even if another permissive bucket-management policy exists.
CREATE POLICY planner_bucket_no_client_create ON storage.buckets AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (id <> 'planner-attachments');
CREATE POLICY planner_bucket_no_client_update ON storage.buckets AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (id <> 'planner-attachments') WITH CHECK (id <> 'planner-attachments');
CREATE POLICY planner_bucket_no_client_delete ON storage.buckets AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (id <> 'planner-attachments');

-- Gate is restrictive: existing broad permissive policies cannot expose this
-- bucket. It does not broaden or revoke access for other buckets.
CREATE POLICY planner_bucket_owner_gate ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (bucket_id <> 'planner-attachments' OR
    (current_user = 'authenticated' AND planner_private.owns_object(name)))
  WITH CHECK (bucket_id <> 'planner-attachments' OR
    (current_user = 'authenticated' AND planner_private.owns_object(name)));
-- Immutable content addresses: even an existing permissive UPDATE policy cannot
-- overwrite or move our objects. To replace a file, upload a new random objectId.
CREATE POLICY planner_bucket_no_overwrite ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated
  USING (bucket_id <> 'planner-attachments')
  WITH CHECK (bucket_id <> 'planner-attachments');
CREATE POLICY planner_files_reserved_upload ON storage.objects AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id <> 'planner-attachments' OR
    (current_user = 'authenticated' AND planner_private.can_upload_object(name,metadata)));
CREATE POLICY planner_files_unreferenced_delete ON storage.objects AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (bucket_id <> 'planner-attachments' OR
    (current_user = 'authenticated' AND planner_private.can_delete_object(name)));
CREATE POLICY planner_files_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'planner-attachments' AND planner_private.owns_object(name));
CREATE POLICY planner_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'planner-attachments' AND planner_private.owns_object(name));
CREATE POLICY planner_files_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'planner-attachments' AND planner_private.owns_object(name));

COMMENT ON SCHEMA planner_api IS 'Review-only planner RPC contract; expose only after approved migration and negative testing';
COMMENT ON TABLE planner_private.documents IS 'Per-confirmed-user snapshot; RPC CAS only; JSON is untrusted data';
COMMIT;
