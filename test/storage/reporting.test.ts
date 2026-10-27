import { test } from "node:test";
import assert from "node:assert/strict";
import { createReportingStorage } from "../../src/reporting/storage.ts";
import { usageFixture } from "../fixtures/reporting.ts";

test("the reporting HTTP driver uses its separate credential and a fixed parameterized query", async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  const query = { from: "2026-10-01", until: "2026-10-28", tool: "all", mode: "local" } as const;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://fixture.pg.psdb.cloud/sql");
    const body = JSON.parse(String(init?.body));
    assert.equal(
      body.query,
      "SELECT app_tracking.admin_usage_v1($1::date,$2::date,$3,$4) AS result",
    );
    assert.deepEqual(body.params, [query.from, query.until, query.tool, query.mode]);
    const headers = new Headers(init?.headers);
    assert.match(headers.get("neon-connection-string")!, /^postgresql:\/\/synthetic_reporter:/);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal, controller.signal);
    return Response.json({
      fields: [{ name: "result", dataTypeID: 3802 }],
      rows: [[JSON.stringify(usageFixture(query))]],
      rowCount: 1,
      command: "SELECT",
      rowAsArray: true,
    });
  };
  try {
    const result = await createReportingStorage(
      "postgresql://synthetic_reporter:synthetic@fixture.pg.psdb.cloud/postgres",
    ).usage(query, controller.signal);
    assert.ok("totals" in result);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("reporting storage refuses destination overrides", () => {
  for (const url of [
    "postgresql://a:b@example.com/postgres",
    "https://a:b@fixture.pg.psdb.cloud/postgres",
    "postgresql://a:b@fixture.pg.psdb.cloud/postgres?host=other",
    "postgresql://a:b@fixture.pg.psdb.cloud/postgres#other",
  ])
    assert.throws(() => createReportingStorage(url));
});
