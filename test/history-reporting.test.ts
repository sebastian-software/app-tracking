import assert from "node:assert/strict";
import test from "node:test";
import { historyQuery, checkedHistory, checkedPublicUsage } from "../src/reporting/history.ts";
import { createReportingHandler } from "../src/reporting/handler.ts";
import { createHistoryPermissionHandler } from "../src/telemetry/history.ts";
import { reportingFixtureAuth, usageFixture } from "./fixtures/reporting.ts";
import { historyFixture, publicUsageFixture } from "./fixtures/history.ts";
const url =
  "https://stats.example/v1/admin/history?from=2026-01-01&until=2026-10-01&tool=all&stream=legacy&mode=local&metric=cli.invocation";
const authorized = () => new Request(url, { headers: { cookie: "reporting-fixture=active" } });

test("monthly history is authenticated, bounded to whole months, and preserves unavailable states", async () => {
  let calls = 0;
  const handler = createReportingHandler(() => {
    calls++;
    return { usage: async (q) => usageFixture(q), history: async (q) => historyFixture(q) };
  }, reportingFixtureAuth());
  assert.equal((await handler(new Request(url))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(authorized());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  const data = await response.json();
  assert.equal(data.retention_months, 24);
  assert.equal(data.months[0].data, null);
  assert.equal(data.months[0].state, "incomplete");
  const query = historyQuery(new URL(url));
  for (const suffix of ["&project=x", "&from=2026-02-01", "&group=version"]) {
    assert.throws(() => historyQuery(new URL(url + suffix)));
  }
  for (const range of ["from=2023-01-01&until=2026-10-01", "from=2026-01-02&until=2026-02-01"]) {
    assert.throws(() => historyQuery(new URL("https://example.test/?" + range)));
  }
  const input = historyFixture(query);
  assert.ok(
    !JSON.stringify(checkedHistory({ ...input, installation_id: "secret" }, query)).includes(
      "secret",
    ),
  );
  const invalid = structuredClone(input);
  invalid.months[0]!.data = {
    count: "1",
    monthly_installations: "1",
    monthly_projects: "1",
    breakdowns: [],
    suppressed_breakdowns: [],
  };
  assert.throws(() => checkedHistory(invalid, query));
});

test("the fixed public projection skips maintainer auth and never exports private breakdowns or identifiers", async () => {
  const auth = reportingFixtureAuth();
  auth.check = async () => {
    throw new Error("Public response must not depend on a session");
  };
  const fixture = publicUsageFixture();
  const handler = createReportingHandler(
    () => ({
      usage: async (q) => usageFixture(q),
      publicUsage: async () => ({
        ...fixture,
        token_hash: "secret",
        series: fixture.series.map((row) => ({
          ...row,
          project_id: "secret",
          breakdowns: ["secret"],
        })),
      }),
    }),
    auth,
  );
  const response = await handler(
    new Request("https://stats.example/v1/public/usage", {
      headers: { cookie: "untrusted", authorization: "Bearer untrusted" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("vary"), null);
  const value = await response.json();
  assert.ok(!JSON.stringify(value).includes("secret"));
  assert.equal(value.series[0].count, "240");
  assert.equal(
    (await handler(new Request("https://stats.example/v1/public/usage?tool=palamedes"))).status,
    400,
  );
  assert.throws(() =>
    checkedPublicUsage({ ...fixture, series: [{ ...fixture.series[0], count: "241" }] }),
  );
  const disabled = createReportingHandler(
    () => ({
      usage: async (q) => usageFixture(q),
      publicUsage: async () => ({ error: "not_found" }),
    }),
    auth,
  );
  assert.equal((await disabled(new Request("https://stats.example/v1/public/usage"))).status, 404);
});

test("historical-retention permission requires its own bounded authenticated request and exact acknowledgement", async () => {
  const id = "a".repeat(64),
    token = "b".repeat(64),
    changedAt = Date.now();
  let calls = 0;
  const handler = createHistoryPermissionHandler({
    async setHistoryPermission(tool, stream, receivedId, hash, enabled, at) {
      calls++;
      assert.equal(tool, "ferriki");
      assert.equal(stream, "events");
      assert.equal(receivedId, id);
      assert.notEqual(hash, token);
      assert.equal(hash.length, 64);
      return { result: { status: "updated", enabled, changed_at: at } };
    },
  });
  const body = {
    schema_version: 1,
    revision: "monthly-history-v1",
    enabled: true,
    changed_at: changedAt,
  };
  const request = (payload: unknown = body, headers: Record<string, string> = {}) =>
    new Request("https://api.example/v1/history-permissions/events/" + id, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "App-Tracking-Tool": "ferriki",
        Authorization: "Bearer " + token,
        ...headers,
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  assert.equal((await handler(request(body, { Authorization: "wrong" }))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handler(request({ ...body, profile_id: "must-not-link" }))).status, 400);
  assert.equal((await handler(request('{"enabled":true,"enabled":false}'))).status, 400);
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), body);
  assert.equal(calls, 1);
  assert.equal((await handler(request(body, { Cookie: "ambient-session" }))).status, 400);
  assert.equal(calls, 1);
});

test("the runtime history switch blocks extended retention grants without blocking withdrawal", async () => {
  let calls = 0;
  const handler = createHistoryPermissionHandler(
    {
      async setHistoryPermission(_tool, _stream, _id, _hash, enabled, changed_at) {
        calls++;
        return { result: { status: "updated", enabled, changed_at } };
      },
    },
    false,
  );
  const send = (enabled: boolean) =>
    handler(
      new Request("https://api.example/v1/history-permissions/events/" + "a".repeat(64), {
        method: "PUT",
        headers: {
          "App-Tracking-Tool": "dalo",
          Authorization: "Bearer " + "b".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schema_version: 1,
          revision: "monthly-history-v1",
          enabled,
          changed_at: Date.now(),
        }),
      }),
    );
  assert.equal((await send(true)).status, 404);
  assert.equal(calls, 0);
  assert.equal((await send(false)).status, 200);
  assert.equal(calls, 1);
});

test("publication requires its own route, revision, runtime switch and exact acknowledgement", async () => {
  let calls = 0;
  const storage = {
    async setHistoryPermission(
      _tool: string,
      _stream: string,
      _id: string,
      _hash: string,
      enabled: boolean,
      changed_at: number,
    ) {
      calls++;
      return { result: { status: "updated", enabled, changed_at } };
    },
  };
  const handler = createHistoryPermissionHandler(storage, true, "public");
  const request = (revision = "public-usage-v1", enabled = true) =>
    new Request("https://api.example/v1/public-permissions/events/" + "a".repeat(64), {
      method: "PUT",
      headers: {
        "App-Tracking-Tool": "palamedes",
        Authorization: "Bearer " + "b".repeat(64),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema_version: 1, revision, enabled, changed_at: 1 }),
    });
  assert.equal((await handler(request("monthly-history-v1"))).status, 400);
  assert.equal(calls, 0);
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    schema_version: 1,
    revision: "public-usage-v1",
    enabled: true,
    changed_at: 1,
  });
  const disabled = createHistoryPermissionHandler(storage, false, "public");
  assert.equal((await disabled(request())).status, 404);
  assert.equal((await disabled(request("public-usage-v1", false))).status, 200);
});
