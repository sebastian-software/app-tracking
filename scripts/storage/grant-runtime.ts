import { psql, quote } from "./psql.ts";

export async function grantRuntime(url: string, role: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid runtime role");
  // Create the LOGIN role separately. It must have no inherited broad privileges.
  await psql(
    url,
    `DO $check$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=${quote(role)} AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolconfig @> ARRAY['statement_timeout=2500ms', 'lock_timeout=1500ms'])
      OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=${quote(role)})
    THEN RAISE EXCEPTION 'runtime_role_must_be_unprivileged'; END IF;
    END $check$;
    GRANT USAGE ON SCHEMA app_tracking TO "${role}";
    GRANT EXECUTE ON FUNCTION app_tracking.register_installation(text,uuid,text,text,timestamptz,text),
      app_tracking.accept_batch(text,uuid,text,uuid,text,jsonb),
      app_tracking.revoke_installation(text,uuid,text),
      app_tracking.register_installation_v1(text,uuid,text,text,timestamptz,text),
      app_tracking.accept_batch_v1(text,uuid,text,uuid,text,text,jsonb) TO "${role}";`,
  );
}
if (import.meta.main) {
  try {
    const url = process.env.MIGRATION_DATABASE_URL,
      role = process.env.RUNTIME_ROLE;
    if (!url || !role) throw new Error("Migration URL and runtime role are required");
    await grantRuntime(url, role);
    console.log("Runtime function grants applied. Verify effective permissions before use.");
  } catch {
    console.error("Runtime grant failed; inspect privately.");
    process.exitCode = 1;
  }
}
