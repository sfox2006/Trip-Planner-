-- READ ONLY project-administrator inspection. No credentials or trip contents.
-- Dashboard Auth/project/API-exposure settings also require manual inspection.
SELECT nspname FROM pg_namespace WHERE nspname IN ('planner_private','planner_api');
SELECT n.nspname AS schema, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='planner_private' OR (n.nspname='storage' AND c.relname IN ('objects','buckets'));
SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname IN ('planner_private','storage') ORDER BY schemaname,tablename,policyname;
SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.table_privileges
WHERE grantee IN ('anon','authenticated','PUBLIC') AND table_schema IN ('planner_private','storage')
ORDER BY table_schema,table_name,grantee,privilege_type;
SELECT n.nspname AS schema,p.proname,p.prosecdef,p.proconfig,p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('planner_private','planner_api') ORDER BY n.nspname,p.proname;
SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='planner-attachments';
SELECT rolname,rolbypassrls FROM pg_roles WHERE rolname IN ('postgres','anon','authenticated','service_role');
SELECT defaclrole::regrole,defaclnamespace::regnamespace,defaclobjtype,defaclacl FROM pg_default_acl;
