-- DISPOSABLE LOCAL DATABASE ONLY. Not a Supabase deployment migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email_confirmed_at timestamptz, is_anonymous boolean DEFAULT false
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets,
  name text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(bucket_id,name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.buckets TO anon,authenticated;
CREATE POLICY adversarial_existing_bucket_policy ON storage.buckets FOR ALL TO anon,authenticated
  USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;
-- Deliberately broad existing policy: the reviewed bucket gates must still deny
-- unauthorized planner access. This is a test adversary, never a production step.
CREATE POLICY adversarial_existing_policy ON storage.objects FOR ALL TO anon,authenticated
  USING (true) WITH CHECK (true);
INSERT INTO auth.users VALUES
 ('11111111-1111-4111-8111-111111111111', now(), false),
 ('22222222-2222-4222-8222-222222222222', now(), false),
 ('33333333-3333-4333-8333-333333333333', NULL, false),
 ('44444444-4444-4444-8444-444444444444', now(), true);
CREATE FUNCTION public.test_assert(condition boolean, message text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %', message; END IF;
  RAISE NOTICE 'PASS: %', message;
END $$;
CREATE FUNCTION public.test_error(statement text, expected_state text, message text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE caught text;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  PERFORM public.test_assert(caught = expected_state, message || ' [SQLSTATE ' || coalesce(caught,'none') || ']');
END $$;
