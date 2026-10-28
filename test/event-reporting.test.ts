import assert from "node:assert/strict";
import test from "node:test";
import { createReportingHandler } from "../src/reporting/handler.ts";
import { checkedEvents, eventQuery, type EventQuery } from "../src/reporting/events.ts";
import { createReportingStorage } from "../src/reporting/storage.ts";
import { reportingFixtureAuth, usageFixture } from "./fixtures/reporting.ts";
import { eventFixture } from "./fixtures/events.ts";
const path = "/v1/admin/events?from=2026-10-01&until=2026-10-28&tool=ferriki&metric=language.use";
const request = (suffix = path, authorized = true) =>
  new Request(`https://stats.example.test${suffix}`, {
    headers: authorized ? { cookie: "reporting-fixture=active" } : {},
  });

test("event reporting checks authorization before constructing a separate aggregate reader", async () => {
  let calls = 0;
  const handler = createReportingHandler(() => {
    calls++;
    return {
      usage: async (query) => usageFixture(query),
      events: async (query) => eventFixture(query),
    };
  }, reportingFixtureAuth());
  assert.equal((await handler(request(path, false))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const result = await response.json();
  assert.equal(result.scope.metric, "language.use");
  assert.equal(result.totals.count, "324");
  assert.equal(result.totals.active_installations, "2");
  assert.equal(
    result.dimensions.find((row: { value: string }) => row.value === "dependency").count,
    "108",
  );
  assert.equal(calls, 1);
  for (const suffix of [
    "&sql=select",
    "&group=project",
    "&metric=resource.download",
    "&collection=opt_out",
    "&mode=all",
  ])
    assert.equal((await handler(request(path + suffix))).status, 400);
  assert.equal(
    (
      await handler(
        new Request(request(), {
          headers: { origin: "https://other.example.test", cookie: "reporting-fixture=active" },
        }),
      )
    ).status,
    403,
  );
});

test("event result serialization preserves metric units and strips private extras", () => {
  const query = eventQuery(new URL(`https://example.test${path}`));
  const fixture = eventFixture(query);
  const source = {
    ...fixture,
    installation_id: "secret",
    profile_id: "secret",
    dimensions: fixture.dimensions.map((row) => ({ ...row, project_id: "secret" })),
  };
  assert.ok(!JSON.stringify(checkedEvents(source, query)).includes("secret"));
  for (const invalid of [
    { ...fixture, scope: { ...fixture.scope, metric: "resource.download" } },
    { ...fixture, totals: { ...fixture.totals, count: "-1" } },
    { ...fixture, totals: { ...fixture.totals, count: "100" } },
    { ...fixture, daily: fixture.daily.slice(1) },
    { ...fixture, systems: [{ dimension: "raw_hardware_model", value: "private", count: "1" }] },
    {
      ...fixture,
      dimensions: [{ tool_id: "other", dimension: "language", value: "rust", count: "1" }],
    },
  ])
    assert.throws(() => checkedEvents(invalid, query));
  for (const suffix of ["&tool=unknown", "&until=2027-01-01", "&from=2026-02-30"])
    assert.throws(() => eventQuery(new URL(`https://example.test${path}${suffix}`)));
});

test("an expired or failed event read is not substituted with successful zeroes", async () => {
  for (const [result, status] of [
    [{ error: "outside_retention", retained_from: "2026-08-01" }, 422],
    [{ error: "private-provider-error" }, 503],
  ] as const) {
    const handler = createReportingHandler(
      () => ({ usage: async (query) => usageFixture(query), events: async () => result }),
      reportingFixtureAuth(),
    );
    const response = await handler(request());
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes("private-provider-error"));
  }
});

test("generic event storage uses a fixed parameterized aggregate query and the reporter credential", async () => {
  const original = globalThis.fetch;
  const query: EventQuery = {
    from: "2026-10-01",
    until: "2026-10-28",
    tool: "ferriki",
    mode: "local",
    metric: "language.use",
  };
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(
        body.query,
        "SELECT app_tracking.admin_events_v1($1::date,$2::date,$3,$4,$5) AS result",
      );
      assert.deepEqual(body.params, [
        query.from,
        query.until,
        query.tool,
        query.mode,
        query.metric,
      ]);
      assert.match(new Headers(init?.headers).get("neon-connection-string")!, /synthetic_reporter/);
      return Response.json({
        fields: [{ name: "result", dataTypeID: 3802 }],
        rows: [[JSON.stringify(eventFixture(query))]],
      });
    };
    const value = await createReportingStorage(
      "postgresql://synthetic_reporter:synthetic@fixture.pg.psdb.cloud/app_tracking",
    ).events!(query, AbortSignal.timeout(2800));
    assert.equal(checkedEvents(value, query).totals.count, "324");
  } finally {
    globalThis.fetch = original;
  }
});
