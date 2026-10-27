import assert from "node:assert/strict";
import test from "node:test";
import { adminTokenHash, createReportingHandler } from "../src/reporting/handler.ts";
import { createService } from "../src/service.ts";
import { usageQuery, checkedUsage, type UsageQuery } from "../src/reporting/contract.ts";
import { fixtureKey, usageFixture } from "./fixtures/reporting.ts";
const path = "/v1/admin/usage?from=2026-10-01&until=2026-10-28";
const request = (suffix = path, key = fixtureKey) =>
  new Request(`https://stats.example.test${suffix}`, {
    headers: { authorization: `Bearer ${key}` },
  });

test("reporting keys are separate and rejected before storage construction", async () => {
  let calls = 0;
  const handler = createReportingHandler(() => {
    calls++;
    throw new Error("storage");
  }, [await adminTokenHash(fixtureKey)]);
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
    [await adminTokenHash(fixtureKey)],
  );
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await response.json()).totals.active_installations, "312");
  assert.deepEqual(seen, [{ from: "2026-10-01", until: "2026-10-28", tool: "all", mode: "local" }]);
  const cross = new Request(request(), {
    headers: { authorization: `Bearer ${fixtureKey}`, origin: "https://other.example.test" },
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
  const hash = await adminTokenHash(fixtureKey);
  const failed = createReportingHandler(
    () => ({
      async usage() {
        throw new Error("postgresql://private:password@host/raw-id");
      },
    }),
    [hash],
  );
  const response = await failed(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "service_unavailable" });
  const expired = createReportingHandler(
    () => ({
      async usage() {
        return { error: "outside_retention", retained_from: "2026-08-01" };
      },
    }),
    [hash],
  );
  assert.equal((await expired(request())).status, 422);
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
  }, [await adminTokenHash(fixtureKey)]);
  const shell = await handler(new Request("https://example.test/admin"));
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.ok(!html.includes(fixtureKey));
  assert.match(html, /method="post"/);
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
