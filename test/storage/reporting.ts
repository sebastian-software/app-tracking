import assert from "node:assert/strict";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { migrate } from "../../scripts/storage/migrate.ts";
import { grantReporting, prepareReportingLogin } from "../../scripts/storage/grant-reporting.ts";
import { grantRuntime } from "../../scripts/storage/grant-runtime.ts";
import { identity, uuid7, hash } from "./fixture.ts";
import type { UsageResult } from "../../src/reporting/contract.ts";

export async function reportingIntegration(
  admin: string,
  runtime: string,
  reporter: string,
  role: string,
) {
  await migrate(admin);
  assert.equal(await prepareReportingLogin(admin, reporter), role);
  assert.equal(await prepareReportingLogin(admin, reporter), role); // Repeated deploys are safe.
  await assert.rejects(prepareReportingLogin(admin, runtime)); // Ingestion authority is forbidden.
  await grantReporting(admin, role);
  const items = Array.from({ length: 5 }, identity);
  items[0]!.consentedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  items[2]!.id = items[0]!.id; // Installation scope includes the tool, even for equal UUID bytes.
  const shared = hash("synthetic-shared-repository"),
    fork = hash("synthetic-fork-repository");
  const sql = (query: string) => psql(admin, query);
  const query = async (
    tool = "all",
    mode = "local",
    from = "CURRENT_DATE-8",
    until = "CURRENT_DATE+1",
  ) =>
    JSON.parse(
      await psql(
        reporter,
        `SELECT app_tracking.admin_usage_v1(${from},${until},${q(tool)},${q(mode)})`,
      ),
    ) as UsageResult;
  let checks = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!,
        tool = i === 2 ? "palamedes" : "dalo",
        mode = i === 3 ? "ci" : "local";
      await sql(
        `SELECT app_tracking.register_installation_v1(${q(tool)},${q(item.id)},${q(item.tokenHash)},'telemetry-v1',${q(item.consentedAt)},${q(mode)})`,
      );
      const batch = uuid7();
      await sql(
        `INSERT INTO app_tracking.telemetry_batches(tool_id,installation_id,batch_id,content_hash,received_at) VALUES (${q(tool)},${q(item.id)},${q(batch)},${q(hash("synthetic-batch"))},clock_timestamp())`,
      );
      const rows =
        i === 0
          ? [
              [8, 3, shared],
              [7, 4, shared],
              [1, 5, null],
              [89, 29, shared],
              [90, 31, shared],
            ]
          : i === 1
            ? [
                [7, 7, shared],
                [0, 11, fork],
              ]
            : i === 2
              ? [[7, 13, shared]]
              : i === 3
                ? [[7, 17, shared]]
                : [[7, 19, shared]];
      for (let n = 0; n < rows.length; n++) {
        const [ago, count, project] = rows[n]!;
        await sql(`INSERT INTO app_tracking.usage_counts(tool_id,installation_id,batch_id,row_number,day,tool_version,command,count,project_id,project_id_version)
          VALUES (${q(tool)},${q(item.id)},${q(batch)},${n + 1},CURRENT_DATE-${ago},'2.0.0',${q(tool === "dalo" ? "status" : "extract")},${count},${project ? q(String(project)) : "NULL"},${project ? "1" : "NULL"})`);
      }
    }
    await sql(
      `UPDATE app_tracking.reporting_installations SET last_activity_at=clock_timestamp()-interval '2161 hours' WHERE installation_id=${q(items[4]!.id)}`,
    );
    let value = await query();
    assert.deepEqual(value.totals, {
      invocations: "43",
      active_installations: "3",
      active_projects: "2",
      unknown_project_invocations: "5",
    });
    checks++;
    assert.equal(
      value.daily.reduce((n, row) => n + Number(row.active_installations), 0),
      6,
    );
    assert.equal(
      value.daily.reduce((n, row) => n + Number(row.active_projects), 0),
      3,
    );
    checks += 2;
    assert.equal((await query("dalo")).totals.invocations, "30");
    assert.equal((await query("palamedes")).totals.active_projects, "1");
    assert.equal((await query("all", "ci")).totals.invocations, "17");
    checks += 3;
    value = await query("all", "local", "CURRENT_DATE-90", "CURRENT_DATE-88");
    assert.equal(value.totals.invocations, "29");
    assert.equal(value.coverage.clipped, true);
    checks += 2;
    const expired = JSON.parse(
      await psql(
        reporter,
        "SELECT app_tracking.admin_usage_v1(CURRENT_DATE-92,CURRENT_DATE-90,'all','local')",
      ),
    );
    assert.equal(expired.error, "outside_retention");
    checks++;
    const wrong = JSON.parse(
      await psql(
        reporter,
        "SELECT app_tracking.admin_usage_v1(CURRENT_DATE-91,CURRENT_DATE+1,'all','local')",
      ),
    );
    assert.equal(wrong.error, "invalid_request");
    checks++;
    const tz = JSON.parse(
      await psql(
        reporter,
        "SET timezone='America/Los_Angeles'; SELECT app_tracking.admin_usage_v1((statement_timestamp() AT TIME ZONE 'UTC')::date-8,(statement_timestamp() AT TIME ZONE 'UTC')::date+1,'all','local')",
      ),
    );
    assert.equal(tz.totals.invocations, "43");
    checks++;
    for (const table of ["usage_counts", "reporting_usage_v1", "reporting_installations"]) {
      await assert.rejects(psql(reporter, `SELECT * FROM app_tracking.${table} LIMIT 1`));
      checks++;
    }
    await assert.rejects(
      psql(
        runtime,
        "SELECT app_tracking.admin_usage_v1(CURRENT_DATE-8,CURRENT_DATE+1,'all','local')",
      ),
    );
    checks++;
    await assert.rejects(
      psql(
        reporter,
        "SELECT app_tracking.register_installation_v1('dalo',NULL,NULL,NULL,NULL,NULL)",
      ),
    );
    checks++;
    await assert.rejects(grantReporting(admin, await psql(runtime, "SELECT current_user")));
    await assert.rejects(grantRuntime(admin, role));
    checks += 2;
    const a = items[0]!;
    // An accepted late batch changes its occurrence day, not its receipt day.
    const day = await sql("SELECT (CURRENT_DATE-1)::text");
    const rows = JSON.stringify([
      {
        day,
        tool_version: "2.0.0",
        command: "status",
        count: 23,
        project_id: shared,
        project_id_version: 1,
      },
    ]);
    const accepted = JSON.parse(
      await psql(
        runtime,
        `SELECT app_tracking.accept_batch_v1('dalo',${q(a.id)},${q(a.tokenHash)},${q(uuid7())},${q(hash(rows))},'telemetry-v1',${q(rows)}::jsonb)`,
      ),
    );
    assert.equal(accepted.status, "accepted");
    assert.equal((await query()).totals.invocations, "66");
    checks += 2;
    assert.equal(
      JSON.parse(
        await psql(
          runtime,
          `SELECT app_tracking.delete_installation_v1('dalo',${q(a.id)},${q(a.tokenHash)})`,
        ),
      ).status,
      "deleted",
    );
    value = await query();
    assert.equal(value.totals.invocations, "31");
    assert.equal(value.totals.active_installations, "2");
    checks += 3;
    const serialized = JSON.stringify(value);
    for (const item of items) {
      assert.ok(!serialized.includes(item.id));
      assert.ok(!serialized.includes(item.tokenHash));
    }
    assert.ok(!serialized.includes(shared));
    assert.ok(!serialized.includes(fork));
    checks++;
    const b = items[1]!;
    await sql(`INSERT INTO app_tracking.usage_counts(tool_id,installation_id,batch_id,row_number,day,tool_version,command,count,project_id,project_id_version)
      SELECT 'dalo',${q(b.id)},batch_id,n+2,CURRENT_DATE,'1.'||n||'.0','status',n,${q(fork)},1
      FROM app_tracking.telemetry_batches CROSS JOIN generate_series(1,110) n WHERE tool_id='dalo' AND installation_id=${q(b.id)} LIMIT 110`);
    value = await query("dalo");
    assert.equal(value.versions.length, 100);
    assert.equal(value.coverage.versions_truncated, true);
    assert.equal(value.versions[0]!.tool_version, "1.110.0");
    checks += 3;
    return { checks, fixture_installations: items.length, public_data: false };
  } finally {
    await sql(
      `DELETE FROM app_tracking.reporting_installations WHERE installation_id IN (${items.map((item) => q(item.id)).join(",")})`,
    );
  }
}

if (import.meta.main) {
  const admin = process.env.MIGRATION_DATABASE_URL,
    runtime = process.env.RUNTIME_DATABASE_URL,
    reporter = process.env.REPORTING_DATABASE_URL,
    role = process.env.REPORTING_ROLE;
  if (!admin || !runtime || !reporter || !role)
    throw new Error("Reporting test configuration missing");
  await grantRuntime(admin, await psql(runtime, "SELECT current_user"));
  try {
    console.log(JSON.stringify(await reportingIntegration(admin, runtime, reporter, role)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reporting test failed");
    process.exitCode = 1;
  }
}
