import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { canonical, sha256 } from "../../src/telemetry/contract.ts";

// All writes, including temporary permission switches, roll back together.
export async function ardoIntegration(admin: string) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(admin).hostname))
    throw new Error("Ardo registration requires a disposable local fixture");
  const owner = process.env.MIGRATION_OWNER_ROLE ?? "postgres";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(owner)) throw new Error("Invalid fixture owner");
  const scenarios = JSON.parse(await readFile("contracts/ardo-invocations.json", "utf8"));
  const hex = () => randomBytes(32).toString("hex");
  const id = hex(),
    tokenHash = await sha256(hex()),
    profile = hex(),
    at = Date.now();
  const batch = {
    schema_version: 1,
    tool_id: "ardo",
    batch_id: hex(),
    installation_id: id,
    collection: "opt_in",
    mode: "local",
    consented_at: at,
    rows: scenarios.commands.map((command: string) => ({
      day: Math.floor(at / 86400000),
      collection: "opt_in",
      count: 1,
      metric: scenarios.metric,
      tool_version: scenarios.version,
      dimensions: { command },
      system: { os: "macos", os_version: "26.1", arch: "aarch64", cpu_family: "apple_m4" },
    })),
  };
  const contentHash = await sha256(canonical(batch));
  // Invalid rows need only a distinct immutable payload hash for the DB validator.
  const submit = (rows = batch.rows, batchId = batch.batch_id) =>
    `app_tracking.accept_events_v1('ardo','opt_in',${q(id)},${q(tokenHash)},${at},'local',${q(batchId)},${q(rows === batch.rows ? contentHash : "f".repeat(64))},${q(JSON.stringify(rows))}::jsonb)`;
  const statements = [
    "BEGIN;",
    `SET LOCAL ROLE "${owner}";`,
    `SELECT ${submit()};`,
    `SELECT ${submit()};`,
    ...scenarios.invalid_commands.map(
      (command: string) =>
        `SELECT ${submit([{ ...batch.rows[0], dimensions: { command } }], hex())};`,
    ),
    "SELECT app_tracking.configure_history_v1(true,true,'synthetic-ardo-review');",
    "SELECT app_tracking.configure_profiles_v1(true,'synthetic-ardo-review');",
    `SELECT app_tracking.set_history_permission_v1('ardo','events',${q(id)},${q(tokenHash)},true,${at});`,
    `SELECT app_tracking.set_public_permission_v1('ardo','events',${q(id)},${q(tokenHash)},true,${at});`,
    `SELECT app_tracking.set_profile_link_v1('ardo',${q(id)},${q(tokenHash)},true,${at},${q(profile)},${q(tokenHash)});`,
    `SELECT app_tracking.set_history_permission_v1('ardo','legacy',${q(id)},${q(tokenHash)},true,${at});`,
    `SELECT app_tracking.set_public_permission_v1('ardo','legacy',${q(id)},${q(tokenHash)},true,${at});`,
    "SELECT app_tracking.admin_events_v1(CURRENT_DATE,CURRENT_DATE+1,'ardo','local','cli.invocation');",
    "SELECT to_jsonb(app_tracking.finalize_history_v1((date_trunc('month',CURRENT_DATE)-interval '1 month')::date,'ardo','events','cli.invocation','local'));",
    "SELECT app_tracking.admin_history_v1((date_trunc('month',CURRENT_DATE)-interval '1 month')::date,date_trunc('month',CURRENT_DATE)::date,'ardo','events','cli.invocation','local');",
    "SELECT jsonb_build_object('private',count(*),'public',(SELECT count(*) FROM app_tracking.public_periods_v1 WHERE tool_id='ardo')) FROM app_tracking.history_periods_v1 WHERE tool_id='ardo';",
    "SELECT app_tracking.count_version_request_v1('ardo','github','stable',200);",
    "SELECT app_tracking.count_version_request_v1('ardo','npm','stable',304);",
    "SELECT app_tracking.count_version_request_v1('ardo','standalone','stable',200);",
    "SELECT app_tracking.admin_service_requests_v1(CURRENT_DATE,CURRENT_DATE+1,'ardo');",
    `SELECT app_tracking.delete_events_v1('ardo',${q(id)},${q(tokenHash)});`,
    "SELECT jsonb_build_object('rows',count(*)) FROM app_tracking.reporting_events_v1 WHERE tool_id='ardo';",
    "ROLLBACK;",
  ];
  const output = (await psql(admin, statements.join("\n")))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const next = () => output.shift();
  assert.equal(next().status, "accepted");
  assert.equal(next().status, "duplicate");
  for (const _ of scenarios.invalid_commands) assert.equal(next().error, "invalid_request");
  // Void configuration calls produce blank lines, filtered above.
  for (let i = 0; i < 3; i++) assert.equal(next().status, "updated");
  assert.equal(next().error, "invalid_request");
  assert.equal(next().error, "invalid_request");
  const events = next();
  assert.equal(events.scope.tool, "ardo");
  assert.equal(events.totals.count, String(scenarios.commands.length));
  assert.deepEqual(
    events.dimensions.map((row: { value: string }) => row.value).sort(),
    [...scenarios.commands].sort(),
  );
  assert.equal(next(), "incomplete");
  const history = next();
  assert.equal(history.months.length, 1);
  assert.equal(history.months[0].tool_id, "ardo");
  assert.deepEqual(next(), { private: 1, public: 1 });
  assert.equal(next().status, "counted");
  assert.equal(next().status, "counted");
  assert.equal(next().error, "invalid_request");
  const service = next();
  assert.equal(service.scope.tool, "ardo");
  assert.deepEqual(service.rows.map((row: { distribution: string }) => row.distribution).sort(), [
    "github",
    "npm",
  ]);
  assert.equal(next().status, "deleted");
  assert.deepEqual(next(), { rows: 0 });
  assert.equal(output.length, 0);
  return { status: "passed" };
}
