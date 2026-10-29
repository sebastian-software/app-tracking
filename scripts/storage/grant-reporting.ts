import { psql, quote } from "./psql.ts";

function roleCheck(role: string, requireLimits: boolean): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid reporting role");
  return `DO $check$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=${quote(role)} AND rolcanlogin AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      ${requireLimits ? "AND rolconfig @> ARRAY['statement_timeout=2500ms', 'lock_timeout=1500ms']" : ""})
      OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=${quote(role)})
      OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app_tracking' AND c.relkind IN ('r','v','m','p','f')
        AND has_table_privilege(${quote(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app_tracking'
        AND p.oid NOT IN ('app_tracking.admin_usage_v1(date,date,text,text)'::regprocedure,
          'app_tracking.admin_service_requests_v1(date,date,text)'::regprocedure,
          'app_tracking.admin_events_v1(date,date,text,text,text)'::regprocedure,
          'app_tracking.admin_history_v1(date,date,text,text,text,text)'::regprocedure,
          'app_tracking.public_usage_v1()'::regprocedure, 'app_tracking.admin_profiles_v1(date,date)'::regprocedure)
        AND has_function_privilege(${quote(role)},p.oid,'EXECUTE'))
    THEN RAISE EXCEPTION 'reporting_role_must_be_unprivileged'; END IF;
    END $check$;`;
}

export function reportingLoginRole(value: string): string {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid reporting database URL");
  const login = decodeURIComponent(url.username);
  const parts = login.split(".");
  if (
    parts.length > 2 ||
    (parts.length === 2 &&
      (!url.hostname.endsWith(".psdb.cloud") ||
        !/^pscale_api_[a-z0-9_]+$/.test(parts[0]!) ||
        !/^[a-z0-9]+$/.test(parts[1]!))) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(parts[0]!)
  )
    throw new Error("Invalid reporting login role");
  return parts[0]!;
}

export async function prepareReportingLogin(migration: string, reporter: string): Promise<string> {
  const role = reportingLoginRole(reporter),
    owner = process.env.MIGRATION_OWNER_ROLE ?? "postgres";
  if (
    decodeURIComponent(new URL(migration).pathname) !==
      decodeURIComponent(new URL(reporter).pathname) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(owner)
  )
    throw new Error("Reporting database scope does not match its owner");
  // The app's existing owner can grant CONNECT without administering roles.
  // Reject inherited/broad authority before adding even this database access.
  await psql(
    migration,
    `BEGIN; SET LOCAL ROLE "${owner}";
    ${roleCheck(role, false)}
    SELECT format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),${quote(role)}) \\gexec
    COMMIT;`,
  );
  // A login may set its own query limits. No cluster-wide role privilege is needed.
  await psql(
    reporter,
    `DO $check$ BEGIN IF current_user<>${quote(role)} THEN RAISE EXCEPTION 'reporting_login_mismatch'; END IF; END $check$;
    ALTER ROLE CURRENT_USER SET statement_timeout='2500ms';
    ALTER ROLE CURRENT_USER SET lock_timeout='1500ms';`,
  );
  return role;
}

export async function grantReporting(url: string, role: string): Promise<void> {
  await psql(
    url,
    `${roleCheck(role, true)}
    GRANT USAGE ON SCHEMA app_tracking TO "${role}";
    GRANT EXECUTE ON FUNCTION app_tracking.admin_usage_v1(date,date,text,text),
      app_tracking.admin_service_requests_v1(date,date,text),
      app_tracking.admin_events_v1(date,date,text,text,text),
      app_tracking.admin_history_v1(date,date,text,text,text,text), app_tracking.public_usage_v1(), app_tracking.admin_profiles_v1(date,date) TO "${role}";`,
  );
}
