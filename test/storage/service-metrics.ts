import assert from "node:assert/strict";
import { psql } from "../../scripts/storage/psql.ts";
import {
  checkedServiceRequests,
  type ServiceRequestResult,
} from "../../src/reporting/service-requests.ts";

// Every counter mutation is rolled back, including when the test fails. No
// synthetic request is added to a real service-demand series by running this.
export async function serviceMetricsIntegration(admin: string, runtime: string, reporter: string) {
  const owner = process.env.MIGRATION_OWNER_ROLE ?? "postgres";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(owner)) throw new Error("Invalid owner");
  const lines = (
    await psql(
      admin,
      `BEGIN; SET LOCAL ROLE "${owner}";
    SELECT app_tracking.admin_service_requests_v1(CURRENT_DATE,CURRENT_DATE+1,'dalo');
    SELECT app_tracking.count_version_request_v1('dalo','npm','stable',200);
    SELECT app_tracking.count_version_request_v1('dalo','npm','stable',200);
    SELECT app_tracking.count_version_request_v1('private','private-path','stable',200);
    SELECT app_tracking.admin_service_requests_v1(CURRENT_DATE,CURRENT_DATE+1,'dalo');
    INSERT INTO app_tracking.service_requests_v1 VALUES('1900-01-01','dalo','npm','stable',200,1);
    SELECT app_tracking.maintain_service_requests_v1(1000);
    SELECT app_tracking.admin_service_requests_v1('1900-01-01','1900-01-02','all');
    ROLLBACK;`,
    )
  ).split("\n");
  const before = JSON.parse(lines[0]!) as ServiceRequestResult;
  const after = JSON.parse(lines[4]!) as ServiceRequestResult;
  const sum = (value: ServiceRequestResult) =>
    value.rows.reduce((n, row) => n + BigInt(row.count), 0n);
  assert.equal(sum(after) - sum(before), 2n);
  assert.equal(JSON.parse(lines[1]!).status, "counted");
  assert.equal(JSON.parse(lines[2]!).status, "counted");
  assert.equal(JSON.parse(lines[3]!).error, "invalid_request");
  assert.ok(Number(lines[5]) >= 1);
  assert.equal(JSON.parse(lines[6]!).error, "outside_retention");
  checkedServiceRequests(after, { ...after.period, tool: "dalo" });
  assert.equal(
    JSON.parse(
      await psql(
        runtime,
        `BEGIN;
    SELECT app_tracking.count_version_request_v1('palamedes','npm','stable',304); ROLLBACK;`,
      ),
    ).status,
    "counted",
  );
  await assert.rejects(
    psql(
      runtime,
      "SELECT app_tracking.admin_service_requests_v1(CURRENT_DATE,CURRENT_DATE+1,'all')",
    ),
  );
  await assert.rejects(
    psql(reporter, "SELECT app_tracking.count_version_request_v1('dalo','npm','stable',200)"),
  );
  for (const url of [runtime, reporter])
    await assert.rejects(psql(url, "SELECT * FROM app_tracking.service_requests_v1 LIMIT 1"));
  const reported = JSON.parse(
    await psql(
      reporter,
      "SELECT app_tracking.admin_service_requests_v1(CURRENT_DATE,CURRENT_DATE+1,'all')",
    ),
  ) as ServiceRequestResult;
  checkedServiceRequests(reported, { ...reported.period, tool: "all" });
  await assert.rejects(
    psql(
      admin,
      `BEGIN; SET LOCAL ROLE "${owner}";
    INSERT INTO app_tracking.event_catalog_v1 VALUES('test-invalid-baseline',
      '{"basic":{"collection":"opt_out","dimensions":{},"system":"full"}}'); ROLLBACK;`,
    ),
  );
  return {
    status: "passed",
    checks: 14,
    scope: "transaction-rolled-back service aggregates and actual role boundaries",
  };
}
