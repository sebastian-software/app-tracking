import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorage, StorageError } from "../../src/storage/database.ts";

// Actual locked driver serialization; synthetic URL only, no database claim.
test("HTTP driver sends one parameterized call to the configured PlanetScale host", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json({
      fields: [{ name: "result", dataTypeID: 3802 }],
      rows: [[JSON.stringify({ status: "accepted" })]],
      rowCount: 1,
      command: "SELECT",
      rowAsArray: true,
    });
  };
  try {
    const storage = createStorage(
      "postgresql://synthetic:synthetic@fixture.pg.psdb.cloud/postgres",
    );
    const response = await storage.submit(
      "dalo",
      "0199e000-0000-7000-8000-000000000001",
      "0".repeat(64),
      "0199e000-0000-7000-8000-000000000002",
      "1".repeat(64),
      [],
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://fixture.pg.psdb.cloud/sql");
    const request = JSON.parse(String(calls[0]!.init.body));
    assert.match(request.query, /SELECT app_tracking.accept_batch\(\$1,/);
    assert.equal(request.params.length, 6);
    assert.equal(request.params[0], "dalo");
    assert.equal(calls[0]!.init.redirect, "error");
    assert.equal(calls[0]!.init.cache, "no-store");
    assert.ok(calls[0]!.init.signal);
    assert.equal(response.subrequests, 1);
    assert.equal(response.result?.status, "accepted");
  } finally {
    globalThis.fetch = original;
  }
});
test("driver failures expose only SQLSTATE, never provider details", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "private credential and query values", code: "22023" },
      { status: 400 },
    );
  try {
    await assert.rejects(
      createStorage("postgresql://synthetic:synthetic@fixture.pg.psdb.cloud/postgres").revoke(
        "dalo",
        "synthetic",
        "synthetic",
      ),
      (e) =>
        e instanceof StorageError && e.code === "22023" && e.message === "Storage operation failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("storage configuration rejects alternate destinations and URL overrides", () => {
  for (const url of [
    "postgresql://a:b@example.com/postgres",
    "https://a:b@fixture.pg.psdb.cloud/postgres",
    "postgresql://a:b@fixture.pg.psdb.cloud/postgres?host=other",
    "postgresql://a:b@fixture.pg.psdb.cloud/postgres#other",
  ]) {
    assert.throws(() => createStorage(url));
  }
});
