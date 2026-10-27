import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  createEventHandler,
  eventBatch,
  type EventCatalog,
  type EventStorage,
} from "../src/telemetry/events.ts";
import { canonical, sha256 } from "../src/telemetry/contract.ts";

export function sampleEventBatch() {
  return {
    schema_version: 1,
    tool_id: "ferriki",
    batch_id: "a".repeat(64),
    collection: "opt_in",
    mode: "local",
    installation_id: "b".repeat(64),
    consented_at: Date.now(),
    rows: [
      {
        day: Math.floor(Date.now() / 86400000),
        metric: "resource.download",
        collection: "opt_in",
        tool_version: "2.0.0",
        dimensions: { kind: "grammar" },
        system: { os: "macos", os_version: "26.1", arch: "aarch64", cpu_family: "apple_m4" },
        count: 1,
        project_id: "d".repeat(64),
        project_id_version: 1,
      },
    ],
  };
}
const noStorage: EventStorage = {
  submitEvents() {
    throw new Error("must not store");
  },
  deleteEvents() {
    throw new Error("must not delete");
  },
};
const request = (value: unknown, authorization = `Bearer ${"c".repeat(64)}`) =>
  new Request("https://tracking.example/v1/event-batches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(value),
  });

test("new event catalog and packaged Rust definitions have identical bytes", async () => {
  assert.equal(
    await readFile("contracts/event-catalog.json", "utf8"),
    await readFile("crates/app-tracking/fixtures/event-catalog.json", "utf8"),
  );
});

test("event dimensions and collection route are checked against trusted definitions", () => {
  assert.equal(eventBatch(sampleEventBatch()).rows.length, 1);
  for (const mutate of [
    (b: ReturnType<typeof sampleEventBatch>) => {
      b.collection = "opt_out";
    },
    (b: ReturnType<typeof sampleEventBatch>) => {
      b.rows[0]!.dimensions.kind = "private-name";
    },
    (b: ReturnType<typeof sampleEventBatch>) => {
      b.rows[0]!.system.cpu_family = "serial-number";
    },
    (b: ReturnType<typeof sampleEventBatch>) => {
      b.rows.push(b.rows[0]!);
    },
    (b: ReturnType<typeof sampleEventBatch>) => {
      b.rows[0]!.count = 0;
    },
  ]) {
    const value = sampleEventBatch();
    mutate(value);
    assert.throws(() => eventBatch(value));
  }
});

test("receiver authenticates opt-in reports and acknowledges canonical immutable bytes", async () => {
  const value = sampleEventBatch();
  let writes = 0;
  const handler = createEventHandler({
    ...noStorage,
    async submitEvents(batch, hash, tokenHash) {
      assert.equal(hash, await sha256(canonical(batch)));
      assert.equal(tokenHash, await sha256("c".repeat(64)));
      writes++;
      return { result: { status: "accepted" } };
    },
  });
  const response = await handler(request(value));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    batch_id: value.batch_id,
    payload_sha256: await sha256(canonical(value)),
  });
  assert.equal(writes, 1);
  assert.equal((await createEventHandler(noStorage)(request(value, ""))).status, 401);
});

test("opt-out path carries no installation or authorization and uses the same handler", async () => {
  const definitions: EventCatalog = {
    fixture: { basic: { collection: "opt_out", dimensions: {}, system: "none" } },
  };
  const value = {
    schema_version: 1,
    tool_id: "fixture",
    batch_id: "a".repeat(64),
    collection: "opt_out",
    mode: "local",
    rows: [
      {
        day: Math.floor(Date.now() / 86400000),
        metric: "basic",
        collection: "opt_out",
        tool_version: "1.0.0",
        dimensions: {},
        count: 2,
      },
    ],
  };
  const handler = createEventHandler(
    {
      ...noStorage,
      async submitEvents(batch, _, tokenHash) {
        assert.equal(batch.installation_id, undefined);
        assert.equal(tokenHash, null);
        return { result: { status: "accepted" } };
      },
    },
    definitions,
  );
  assert.equal((await handler(request(value, ""))).status, 200);
  assert.equal((await createEventHandler(noStorage, definitions)(request(value))).status, 401);
  assert.equal(
    (
      await createEventHandler(
        noStorage,
        definitions,
      )(request({ ...value, installation_id: "d".repeat(64) }, ""))
    ).status,
    400,
  );
});

test("unknown fields, malformed envelopes and duplicate JSON keys fail before storage", async () => {
  const handler = createEventHandler(noStorage);
  assert.equal((await handler(request({ ...sampleEventBatch(), argv: "private" }))).status, 400);
  const duplicate = request(sampleEventBatch());
  const text = (await duplicate.text()).replace(
    '"schema_version":1',
    '"schema_version":1,"schema_version":1',
  );
  assert.equal(
    (
      await handler(
        new Request(duplicate.url, { method: "POST", headers: duplicate.headers, body: text }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        new Request("https://tracking.example/v1/event-batches?secret=x", { method: "POST" }),
      )
    ).status,
    400,
  );
});
