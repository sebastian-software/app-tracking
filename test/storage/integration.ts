import assert from "node:assert/strict";
import { migrate } from "../../scripts/storage/migrate.ts";
import { grantRuntime } from "../../scripts/storage/grant-runtime.ts";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { withInstallationLock } from "./lock.ts";
import { identity, uuid7, maxRows, hash } from "./fixture.ts";

// Opt-in executable integration suite; it writes only its own synthetic installations.
export async function storageIntegration(admin: string, runtime: string, role: string) {
  const sql = (text: string) => psql(admin, text);
  const run = (text: string) => psql(runtime, text);
  const ids: string[] = [];
  let checks = 0;
  await migrate(admin);
  await migrate(admin);
  checks += 2;
  await grantRuntime(admin, role);
  if (process.env.MIGRATION_OWNER_ROLE && process.env.MIGRATION_OWNER_ROLE !== "postgres") {
    assert.equal(
      await sql(
        "SELECT rolcreatedb OR rolcreaterole OR rolsuper FROM pg_roles WHERE rolname=current_user",
      ),
      "f",
    );
    checks++;
  }
  async function registration() {
    const item = identity();
    ids.push(item.id);
    const statement = `SELECT app_tracking.register_installation('dalo',${q(item.id)},${q(item.tokenHash)},'telemetry-v1',${q(item.consentedAt)},'local')`;
    assert.equal(JSON.parse(await run(statement)).status, "registered");
    assert.equal(JSON.parse(await run(statement)).status, "duplicate");
    checks += 2;
    return item;
  }
  let phase = "registration";
  try {
    const a = await registration();
    const batch = uuid7(),
      rows = maxRows();
    const submit = (batchId = batch, data = rows, content = hash(JSON.stringify(data))) =>
      `SELECT app_tracking.accept_batch('dalo',${q(a.id)},${q(a.tokenHash)},${q(batchId)},${q(content)},${q(JSON.stringify(data))}::jsonb)`;
    phase = "concurrent_duplicates";
    // Two direct TCP sessions prove database serialization. The live HTTP probe
    // separately exercises eight concurrent requests through the production driver.
    const replies = await Promise.all(Array.from({ length: 2 }, () => run(submit())));
    assert.equal(replies.filter((v) => JSON.parse(v).status === "accepted").length, 1);
    assert.equal(replies.filter((v) => JSON.parse(v).status === "duplicate").length, 1);
    assert.equal(
      await sql(`SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(a.id)}`),
      "256",
    );
    checks += 3;
    await assert.rejects(run(submit(batch, rows, hash("changed-content"))));
    checks++;
    phase = "late_insert_rollback";
    // Force a constraint failure in the final INSERT, after receipt/quota writes.
    const broken = uuid7();
    await assert.rejects(run(submit(broken, [...rows.slice(0, 1), { ...rows[1]!, count: 0 }])));
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.telemetry_batches WHERE installation_id=${q(a.id)} AND batch_id=${q(broken)}`,
      ),
      "0",
    );
    assert.equal(
      await sql(
        `SELECT sum(count) FROM app_tracking.daily_quotas WHERE installation_id=${q(a.id)}`,
      ),
      "256",
    );
    checks += 3;
    phase = "foreign_key";
    // Cross-tool association cannot pass the composite foreign key.
    await assert.rejects(
      sql(
        `INSERT INTO app_tracking.telemetry_batches VALUES ('palamedes',${q(a.id)},${q(uuid7())},${q(hash("fk"))},now())`,
      ),
    );
    checks++;
    phase = "lock_serialization";
    // Hold the installation lock in a separate real transaction. The write must wait.
    const locked = uuid7();
    await withInstallationLock(admin, a.id, async () => {
      await assert.rejects(run(submit(locked)), /55P03/);
      assert.equal(
        await sql(
          `SELECT count(*) FROM app_tracking.telemetry_batches WHERE installation_id=${q(a.id)} AND batch_id=${q(locked)}`,
        ),
        "0",
      );
    });
    assert.equal(JSON.parse(await run(submit(locked))).status, "accepted");
    checks += 3;
    phase = "lost_acknowledgement";
    // A response deliberately discarded after commit is an unknown outcome to the caller.
    const lost = uuid7();
    await run(submit(lost));
    assert.equal(JSON.parse(await run(submit(lost))).status, "duplicate");
    checks++;
    phase = "delayed_acknowledgement";
    // A transport deadline while the server may continue must also be retry-safe.
    const delayed = uuid7();
    const pending = run(`BEGIN; ${submit(delayed)}; SELECT pg_sleep(0.4); COMMIT;`);
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 10))]);
    await pending;
    assert.equal(JSON.parse(await run(submit(delayed))).status, "duplicate");
    checks++;
    phase = "runtime_permissions";
    // An application role can execute fixed functions, but cannot read/write tables or DDL.
    for (const forbidden of [
      "CREATE TABLE app_tracking.forbidden(id integer)",
      "SELECT * FROM app_tracking.reporting_installations",
      "DELETE FROM app_tracking.telemetry_batches",
      "CREATE FUNCTION app_tracking.forbidden() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    ]) {
      await assert.rejects(run(forbidden));
      checks++;
    }
    phase = "transaction_rollback";
    // Full statement rollback restores last activity as well as receipt, quota and usage.
    const before = await sql(
      `SELECT last_activity_at FROM app_tracking.reporting_installations WHERE installation_id=${q(a.id)}`,
    );
    await assert.rejects(run(`BEGIN; ${submit(uuid7())}; SELECT 1/0; COMMIT;`));
    assert.equal(
      await sql(
        `SELECT last_activity_at FROM app_tracking.reporting_installations WHERE installation_id=${q(a.id)}`,
      ),
      before,
    );
    checks += 2;
    phase = "revocation";
    await run(`SELECT app_tracking.revoke_installation('dalo',${q(a.id)},${q(a.tokenHash)})`);
    await assert.rejects(run(submit()));
    assert.equal(
      await sql(`SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(a.id)}`),
      "0",
    );
    checks += 2;
    return { checks, maximum_rows: rows.length, sql_atomicity: "passed" };
  } catch (error) {
    const details = error as {
      code?: unknown;
      category?: unknown;
      message?: string;
      operator?: unknown;
      actual?: { message?: string };
    };
    const state =
      (details.message ?? "").match(/Database operation failed \(([0-9A-Z]{5})\)/)?.[1] ??
      details.actual?.message?.match(/Database operation failed \(([0-9A-Z]{5})\)/)?.[1];
    console.error(
      JSON.stringify({
        storage_test_phase: phase,
        sqlstate: state,
        category: typeof details.category === "string" ? details.category : undefined,
        assertion: details.code === "ERR_ASSERTION",
        operator: typeof details.operator === "string" ? details.operator : undefined,
      }),
    );
    throw error;
  } finally {
    for (const id of ids)
      await sql(
        `DELETE FROM app_tracking.reporting_installations WHERE installation_id=${q(id)} AND tool_id='dalo'`,
      );
  }
}
if (import.meta.main) {
  try {
    const admin = process.env.MIGRATION_DATABASE_URL,
      runtime = process.env.RUNTIME_DATABASE_URL,
      role = process.env.RUNTIME_ROLE;
    if (!admin || !runtime || !role) throw new Error("Database test configuration missing");
    console.log(JSON.stringify(await storageIntegration(admin, runtime, role)));
  } catch {
    console.error(
      "Storage integration failed. Inspect privately; no SQL/provider details were logged.",
    );
    process.exitCode = 1;
  }
}
