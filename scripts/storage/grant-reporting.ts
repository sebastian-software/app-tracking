import { psql, quote } from "./psql.ts";

export async function grantReporting(url: string, role: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid reporting role");
  await psql(
    url,
    `DO $check$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=${quote(role)} AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolconfig @> ARRAY['statement_timeout=2500ms', 'lock_timeout=1500ms'])
      OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=${quote(role)})
      OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app_tracking' AND c.relkind IN ('r','v','m','p','f')
        AND has_table_privilege(${quote(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app_tracking'
        AND p.oid<>'app_tracking.admin_usage_v1(date,date,text,text)'::regprocedure
        AND has_function_privilege(${quote(role)},p.oid,'EXECUTE'))
    THEN RAISE EXCEPTION 'reporting_role_must_be_unprivileged'; END IF;
    END $check$;
    GRANT USAGE ON SCHEMA app_tracking TO "${role}";
    GRANT EXECUTE ON FUNCTION app_tracking.admin_usage_v1(date,date,text,text) TO "${role}";`,
  );
}
