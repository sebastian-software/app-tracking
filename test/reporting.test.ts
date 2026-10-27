import assert from "node:assert/strict";
import test from "node:test";
import { createReportingHandler } from "../src/reporting/handler.ts";
import { createService } from "../src/service.ts";
import { usageQuery, checkedUsage, type UsageQuery } from "../src/reporting/contract.ts";
import { reportingFixtureAuth, usageFixture } from "./fixtures/reporting.ts";
import { createReportingStorage, reportingFailureLabel } from "../src/reporting/storage.ts";
const path = "/v1/admin/usage?from=2026-10-01&until=2026-10-28";
const request = (suffix = path, session = "active") =>
  new Request(`https://stats.example.test${suffix}`, {
    headers:
      session === "active"
        ? { cookie: "reporting-fixture=active" }
        : session
          ? { authorization: `Bearer ${session}` }
          : {},
  });

test("reporting HTTP failures retain only bounded transport diagnostics", async () => {
  const original = globalThis.fetch;
  const storage = createReportingStorage(
    "postgresql://fixture:private@fixture.pg.psdb.cloud/app_tracking",
  );
  const query: UsageQuery = { from: "2026-10-01", until: "2026-10-02", tool: "all", mode: "local" };
  try {
    for (const status of [401, 403, 503]) {
      globalThis.fetch = async () => new Response("private provider details", { status });
      await assert.rejects(storage.usage(query, new AbortController().signal), (error: unknown) => {
        assert.equal(reportingFailureLabel(error), "http_" + status);
        assert.ok(error instanceof Error && !error.message.includes("private"));
        return true;
      });
    }
    globalThis.fetch = async () => {
      throw new DOMException("private provider details", "TimeoutError");
    };
    await assert.rejects(storage.usage(query, new AbortController().signal), (error: unknown) => {
      assert.equal(reportingFailureLabel(error), "timeout");
      return true;
    });
    assert.equal(reportingFailureLabel({ code: "private provider details" }), "unavailable");
  } finally {
    globalThis.fetch = original;
  }
});

test("unauthorized sessions and legacy keys are rejected before storage construction", async () => {
  let calls = 0;
  const handler = createReportingHandler(() => {
    calls++;
    throw new Error("storage");
  }, reportingFixtureAuth());
  for (const key of ["", "a".repeat(64), `at_admin_v1_${"b".repeat(64)}`]) {
    const response = await handler(request(path, key));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  assert.equal(calls, 0);
  assert.equal((await handler(request())).status, 503);
  assert.equal(calls, 1);
});
test("fixed aggregate route is bounded, authenticated, and uncached", async () => {
  const seen: UsageQuery[] = [];
  const handler = createReportingHandler(
    () => ({
      async usage(query) {
        seen.push(query);
        return usageFixture(query);
      },
    }),
    reportingFixtureAuth(),
  );
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await response.json()).totals.active_installations, "312");
  assert.deepEqual(seen, [{ from: "2026-10-01", until: "2026-10-28", tool: "all", mode: "local" }]);
  const cross = new Request(request(), {
    headers: { cookie: "reporting-fixture=active", origin: "https://other.example.test" },
  });
  assert.equal((await handler(cross)).status, 403);
  assert.equal(seen.length, 1);
  for (const suffix of ["&sql=DROP", "&tool=all&tool=dalo", "&mode=all", "&group=project"])
    assert.equal((await handler(request(path + suffix))).status, 400);
});
test("dates reject overflow, reversed windows, and more than 90 days", () => {
  for (const range of [
    "from=0000-01-01&until=0000-01-02",
    "from=2026-02-30&until=2026-03-02",
    "from=2026-10-28&until=2026-10-01",
    "from=2026-01-01&until=2026-10-28",
  ]) {
    assert.throws(() => usageQuery(new URL(`https://example.test/?${range}`)));
  }
});
test("database errors are redacted and expiry is not a successful zero", async () => {
  const failed = createReportingHandler(
    () => ({
      async usage() {
        throw new Error("postgresql://private:password@host/raw-id");
      },
    }),
    reportingFixtureAuth(),
  );
  const response = await failed(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "service_unavailable" });
  assert.equal(response.headers.get("X-App-Tracking-Reporting-Failure"), "storage:unavailable");
  const expired = createReportingHandler(
    () => ({
      async usage() {
        return { error: "outside_retention", retained_from: "2026-08-01" };
      },
    }),
    reportingFixtureAuth(),
  );
  assert.equal((await expired(request())).status, 422);
});
test("reporting diagnostics expose only fixed stages and allowed SQLSTATE codes", async () => {
  for (const code of ["42501", "postgresql://private:password@host"]) {
    const handler = createReportingHandler(
      () => ({
        async usage() {
          throw Object.assign(new Error("private database details"), { code });
        },
      }),
      reportingFixtureAuth(),
    );
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(
      response.headers.get("X-App-Tracking-Reporting-Failure"),
      code === "42501" ? "storage:42501" : "storage:unavailable",
    );
    assert.ok(!JSON.stringify([...response.headers]).includes("private" + " database"));
  }
  const handler = createReportingHandler(
    () => ({
      async usage(query) {
        return { ...usageFixture(query), schema_version: 2 } as never;
      },
    }),
    reportingFixtureAuth(),
  );
  assert.equal(
    (await handler(request())).headers.get("X-App-Tracking-Reporting-Failure"),
    "contract:unavailable",
  );
});
test("aggregate serialization drops unexpected private fields and rejects malformed counts", () => {
  const query = usageQuery(new URL(`https://example.test${path}`));
  const source = {
    ...usageFixture(query),
    token_hash: "private",
    installation_id: "private",
    project_id: "private",
  };
  assert.ok(!JSON.stringify(checkedUsage(source, query)).includes("private"));
  assert.throws(() =>
    checkedUsage({ ...source, totals: { ...source.totals, invocations: -1 } }, query),
  );
});
test("view contains no credential or usage and is independently gated", async () => {
  const handler = createReportingHandler(() => {
    throw new Error("Must remain lazy");
  }, reportingFixtureAuth());
  const shell = await handler(new Request("https://example.test/admin"));
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.ok(!html.includes("reporting-fixture=active"));
  assert.match(html, /Continue with WorkOS/);
  assert.match(shell.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  const disabled = createService(() => undefined);
  assert.equal((await disabled(new Request("https://example.test/v1/admin/usage"))).status, 404);
  const service = createService(
    () => undefined,
    {},
    () => {
      throw new Error("reporting config");
    },
  );
  assert.equal((await service(new Request("https://example.test/health"))).status, 200);
});
