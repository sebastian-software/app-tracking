import assert from "node:assert/strict";
import test from "node:test";
import { createReportingHandler } from "../src/reporting/handler.ts";
import {
  checkedServiceRequests,
  serviceQuery,
  type ServiceRequestResult,
} from "../src/reporting/service-requests.ts";
import { reportingFixtureAuth, usageFixture } from "./fixtures/reporting.ts";

const target = "https://stats.example/v1/admin/service-requests?from=2026-10-01&until=2026-10-29";
const fixture = (): ServiceRequestResult => ({
  schema_version: 1,
  period: { from: "2026-10-01", until: "2026-10-29", covered_from: "2026-10-01" },
  scope: { tool: "all" },
  coverage: { unit: "origin_version_requests", retained_from: "2024-10-29", clipped: false },
  rows: [
    {
      day: "2026-10-28",
      tool_id: "dalo",
      distribution: "npm",
      channel: "stable",
      status: 200,
      count: "42",
    },
  ],
});
test("service statistics require existing reporting authorization and project only aggregate fields", async () => {
  let calls = 0;
  const handle = createReportingHandler(
    () => ({
      usage: async (q) => usageFixture(q),
      async serviceRequests() {
        calls++;
        return {
          ...fixture(),
          private: "secret",
          rows: fixture().rows.map((r) => ({ ...r, ip: "secret" })),
        };
      },
    }),
    reportingFixtureAuth(),
  );
  assert.equal((await handle(new Request(target))).status, 401);
  assert.equal(calls, 0);
  const response = await handle(
    new Request(target, { headers: { cookie: "reporting-fixture=active" } }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fixture());
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.equal(calls, 1);
});
test("service statistics reject unbounded queries, wrong scope, private labels, and malformed counts", () => {
  for (const suffix of ["&mode=ci", "&tool=private", "&from=2026-10-02", "&project_id=x"])
    assert.throws(() => serviceQuery(new URL(target + suffix)));
  const query = serviceQuery(new URL(target));
  for (const row of [
    { ...fixture().rows[0], day: "2026-09-30" },
    { ...fixture().rows[0], tool_id: "private" },
    { ...fixture().rows[0], distribution: "private-path" },
    { ...fixture().rows[0], count: "-1" },
    { ...fixture().rows[0], count: "1000000000001" },
    { ...fixture().rows[0], status: 201 },
  ])
    assert.throws(() => checkedServiceRequests({ ...fixture(), rows: [row] }, query));
  assert.throws(() =>
    checkedServiceRequests({ ...fixture(), rows: [...fixture().rows, ...fixture().rows] }, query),
  );
  assert.throws(() => checkedServiceRequests({ ...fixture(), scope: { tool: "dalo" } }, query));
});
